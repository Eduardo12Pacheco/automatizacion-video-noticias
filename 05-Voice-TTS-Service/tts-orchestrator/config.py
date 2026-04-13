from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class OrchestratorConfig:
    runtime_dir: Path
    worker_base_url: str
    worker_internal_token: str
    frontend_api_key: str
    basic_user: str
    basic_pass: str
    request_timeout_sec: int
    poll_timeout_sec: int
    rate_limit_per_min: int
    queue_max_hint: int
    allowed_origins: list[str]


def load_config() -> OrchestratorConfig:
    root = Path(__file__).resolve().parent
    runtime_dir = Path(os.getenv("TTS_ORCH_RUNTIME_DIR", root / "runtime")).resolve()

    origins_raw = os.getenv("TTS_ORCH_ALLOWED_ORIGINS", "http://localhost:8080")
    allowed_origins = [x.strip() for x in origins_raw.split(",") if x.strip()]

    return OrchestratorConfig(
        runtime_dir=runtime_dir,
        worker_base_url=os.getenv("TTS_ORCH_WORKER_BASE_URL", "http://127.0.0.1:8091").rstrip("/"),
        worker_internal_token=os.getenv("TTS_ORCH_WORKER_INTERNAL_TOKEN", ""),
        frontend_api_key=os.getenv("TTS_ORCH_FRONTEND_API_KEY", ""),
        basic_user=os.getenv("TTS_ORCH_BASIC_USER", ""),
        basic_pass=os.getenv("TTS_ORCH_BASIC_PASS", ""),
        request_timeout_sec=_env_int("TTS_ORCH_REQUEST_TIMEOUT_SEC", 30),
        poll_timeout_sec=_env_int("TTS_ORCH_POLL_TIMEOUT_SEC", 30),
        rate_limit_per_min=_env_int("TTS_ORCH_RATE_LIMIT_PER_MIN", 10),
        queue_max_hint=_env_int("TTS_ORCH_QUEUE_MAX_HINT", 20),
        allowed_origins=allowed_origins,
    )
