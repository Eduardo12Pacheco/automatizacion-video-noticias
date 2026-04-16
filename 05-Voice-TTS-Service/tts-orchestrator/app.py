from __future__ import annotations

import json
import secrets
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from config import OrchestratorConfig, load_config
from schemas import CreatePublicJobRequest, CreatePublicJobResponse
from security import SlidingWindowRateLimiter
from store import OrchestratorStore


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


cfg: OrchestratorConfig = load_config()
store = OrchestratorStore(cfg.runtime_dir / "orchestrator.db")
rate_limiter = SlidingWindowRateLimiter(max_per_minute=cfg.rate_limit_per_min)

app = FastAPI(title="tts-orchestrator", version="0.1.0")
ALLOWED_PRESETS = {'balanced_default', 'golazo_emotivo', 'golazo_informativo', 'default'}
basic_scheme = HTTPBasic(auto_error=False)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "x-api-key", "Authorization", "x-user-email"],
)


@app.on_event("startup")
def startup() -> None:
    cfg.runtime_dir.mkdir(parents=True, exist_ok=True)
    if not cfg.worker_internal_token:
        raise RuntimeError("TTS_ORCH_WORKER_INTERNAL_TOKEN es obligatorio")
    if not cfg.frontend_api_key:
        raise RuntimeError("TTS_ORCH_FRONTEND_API_KEY es obligatorio")
    if not cfg.basic_user or not cfg.basic_pass:
        raise RuntimeError("TTS_ORCH_BASIC_USER y TTS_ORCH_BASIC_PASS son obligatorios")


def _error(code: str, message: str, status_code: int, details: dict | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": {"code": code, "message": message, "details": details}},
    )


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if x_api_key != cfg.frontend_api_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="UNAUTHORIZED")


def require_basic_auth(credentials: HTTPBasicCredentials | None = Depends(basic_scheme)) -> None:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="UNAUTHORIZED",
            headers={"WWW-Authenticate": "Basic"},
        )

    ok_user = secrets.compare_digest(credentials.username or "", cfg.basic_user)
    ok_pass = secrets.compare_digest(credentials.password or "", cfg.basic_pass)
    if not (ok_user and ok_pass):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="UNAUTHORIZED",
            headers={"WWW-Authenticate": "Basic"},
        )


def current_user_email(
    cf_access_authenticated_user_email: str | None = Header(default=None),
    x_user_email: str | None = Header(default=None),
) -> str:
    # En producción usar el header de Cloudflare Access.
    # x-user-email queda como fallback para dev local.
    user = (cf_access_authenticated_user_email or x_user_email or "unknown@local").strip().lower()
    return user or "unknown@local"


async def _worker_post(path: str, payload: dict) -> httpx.Response:
    headers = {"x-internal-token": cfg.worker_internal_token}
    timeout = httpx.Timeout(cfg.request_timeout_sec)
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.post(f"{cfg.worker_base_url}{path}", headers=headers, json=payload)


async def _worker_get(path: str, stream: bool = False) -> httpx.Response:
    headers = {"x-internal-token": cfg.worker_internal_token}
    timeout = httpx.Timeout(cfg.poll_timeout_sec)
    async with httpx.AsyncClient(timeout=timeout) as client:
        if stream:
            return await client.get(f"{cfg.worker_base_url}{path}", headers=headers)
        return await client.get(f"{cfg.worker_base_url}{path}", headers=headers)


def _normalize_public_job(data: dict, job_id: str) -> dict:
    download_url = None
    if data.get("status") == "done":
        download_url = f"/api/tts/jobs/{job_id}/download"

    return {
        "job_id": data.get("job_id", job_id),
        "status": data.get("status", "queued"),
        "progress": {
            **(data.get("progress") or {"stage": "queued"}),
            "percent": _safe_percent((data.get("progress") or {}).get("percent")),
        },
        "created_at": data.get("created_at"),
        "started_at": data.get("started_at"),
        "finished_at": data.get("finished_at"),
        "error": data.get("error"),
        "download_url": download_url,
    }


def _sse_event(event: str, payload: dict) -> bytes:
    body = json.dumps(payload, ensure_ascii=False)
    return f"event: {event}\ndata: {body}\n\n".encode("utf-8")


def _safe_percent(value: object) -> int:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, min(100, parsed))


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "worker_base_url": cfg.worker_base_url,
        "rate_limit_per_min": cfg.rate_limit_per_min,
        "queue_max_hint": cfg.queue_max_hint,
    }


@app.post(
    "/api/tts/jobs",
    response_model=CreatePublicJobResponse,
    dependencies=[Depends(require_basic_auth), Depends(require_api_key)],
    status_code=202,
)
async def create_job(payload: CreatePublicJobRequest, user_email: str = Depends(current_user_email)):
    allowed, retry_after = rate_limiter.allow(user_email)
    if not allowed:
        return _error(
            code="RATE_LIMITED",
            message="Demasiadas solicitudes. Intentá de nuevo más tarde.",
            status_code=429,
            details={"retry_after_seconds": retry_after},
        )

    requested_profile = (payload.voice_profile or '').strip() or 'balanced_default'
    if requested_profile not in ALLOWED_PRESETS:
        return _error("INVALID_TEXT", "voice_profile inválido.", 400)
    resolved_profile = 'balanced_default' if requested_profile == 'default' else requested_profile

    if payload.request_id:
        existing_job = store.get_job_for_request_id(user_email=user_email, request_id=payload.request_id)
        if existing_job:
            return CreatePublicJobResponse(
                job_id=existing_job,
                status="queued",
                position=None,
                eta_seconds=None,
                created_at=utc_now(),
            )

    job_id = f"job_{uuid4().hex[:16]}"
    internal_payload = {
        "job_id": job_id,
        "text": payload.text,
        "voice_profile": resolved_profile,
        "requested_by": user_email,
    }

    try:
        resp = await _worker_post("/internal/jobs", internal_payload)
    except httpx.HTTPError:
        return _error("INTERNAL_ERROR", "No se pudo contactar al worker interno.", 500)

    if resp.status_code == 429:
        return _error("QUEUE_FULL", "La cola está llena. Intentá más tarde.", 429)
    if resp.status_code >= 400:
        return _error("INTERNAL_ERROR", "El worker devolvió un error al crear el job.", 500)

    data = resp.json()
    if payload.request_id:
        store.save_request_mapping(user_email=user_email, request_id=payload.request_id, job_id=job_id)
    store.add_audit(
        user_email=user_email,
        action="create_job",
        job_id=job_id,
        meta_json=json.dumps({"title": payload.title, "text_length": len(payload.text)}, ensure_ascii=False),
    )

    return CreatePublicJobResponse(
        job_id=job_id,
        status=str(data.get("status", "queued")),
        position=None,
        eta_seconds=None,
        created_at=utc_now(),
    )


@app.get("/api/tts/jobs/{job_id}", dependencies=[Depends(require_basic_auth), Depends(require_api_key)])
async def get_job(job_id: str, user_email: str = Depends(current_user_email)):
    try:
        resp = await _worker_get(f"/internal/jobs/{job_id}")
    except httpx.HTTPError:
        return _error("INTERNAL_ERROR", "No se pudo consultar estado del worker.", 500)

    if resp.status_code == 404:
        return _error("JOB_NOT_FOUND", "No existe el job solicitado.", 404)
    if resp.status_code >= 400:
        return _error("INTERNAL_ERROR", "Error consultando estado del job.", 500)

    data = resp.json()
    public_data = _normalize_public_job(data, job_id)

    store.add_audit(user_email=user_email, action="get_job", job_id=job_id, meta_json=None)

    return public_data


@app.get(
    "/api/tts/jobs/{job_id}/events",
    dependencies=[Depends(require_basic_auth), Depends(require_api_key)],
)
async def stream_job_events(job_id: str, request: Request, user_email: str = Depends(current_user_email)):
    async def event_generator():
        last_payload = None
        idle_seconds = 0

        while True:
            if await request.is_disconnected():
                break

            try:
                resp = await _worker_get(f"/internal/jobs/{job_id}")
            except httpx.HTTPError:
                yield _sse_event("error", {"code": "INTERNAL_ERROR", "message": "No se pudo consultar estado del worker."})
                break

            if resp.status_code == 404:
                yield _sse_event("error", {"code": "JOB_NOT_FOUND", "message": "No existe el job solicitado."})
                break

            if resp.status_code >= 400:
                yield _sse_event("error", {"code": "INTERNAL_ERROR", "message": "Error consultando estado del job."})
                break

            public_data = _normalize_public_job(resp.json(), job_id)
            serialized = json.dumps(public_data, ensure_ascii=False, sort_keys=True)

            if serialized != last_payload:
                yield _sse_event("status", public_data)
                last_payload = serialized
                idle_seconds = 0
            else:
                idle_seconds += cfg.stream_poll_interval_sec
                if idle_seconds >= cfg.stream_heartbeat_sec:
                    yield b": heartbeat\n\n"
                    idle_seconds = 0

            status_value = (public_data.get("status") or "").lower()
            if status_value in {"done", "error", "cancelled"}:
                break

            await asyncio.sleep(cfg.stream_poll_interval_sec)

        store.add_audit(user_email=user_email, action="stream_job", job_id=job_id, meta_json=None)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_generator(), media_type="text/event-stream", headers=headers)


@app.get(
    "/api/tts/jobs/{job_id}/download",
    dependencies=[Depends(require_basic_auth), Depends(require_api_key)],
)
async def download_job(job_id: str, user_email: str = Depends(current_user_email)):
    try:
        resp = await _worker_get(f"/internal/jobs/{job_id}/artifact", stream=True)
    except httpx.HTTPError:
        return _error("INTERNAL_ERROR", "No se pudo descargar el audio desde worker.", 500)

    if resp.status_code == 404:
        return _error("JOB_NOT_FOUND", "No existe el job solicitado.", 404)
    if resp.status_code == 409:
        return _error("JOB_NOT_READY", "El job todavía no terminó.", 409)
    if resp.status_code == 410:
        return _error("ARTIFACT_EXPIRED", "El artefacto ya no está disponible.", 410)
    if resp.status_code >= 400:
        return _error("INTERNAL_ERROR", "Error descargando artefacto del worker.", 500)

    store.add_audit(user_email=user_email, action="download_job", job_id=job_id, meta_json=None)

    content_type = resp.headers.get("content-type", "audio/wav")
    disposition = resp.headers.get("content-disposition", f'attachment; filename="{job_id}.wav"')
    return Response(content=resp.content, media_type=content_type, headers={"Content-Disposition": disposition})


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    if exc.detail == "UNAUTHORIZED":
        return _error("UNAUTHORIZED", "No autorizado.", exc.status_code)
    return _error("INTERNAL_ERROR", str(exc.detail), exc.status_code)
