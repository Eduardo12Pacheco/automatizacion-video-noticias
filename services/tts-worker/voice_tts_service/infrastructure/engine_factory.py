from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from newsroom_worker_common.gpu_slot import GpuSlot

from voice_tts_service.infrastructure.piper import PiperEngine, PiperUnavailable
from voice_tts_service.infrastructure.qwen import QwenCloneEngine

ENGINE_QWEN = "qwen"
ENGINE_PIPER = "piper"
ENGINE_AUTO = "auto"
ENGINE_MODES = {ENGINE_QWEN, ENGINE_PIPER, ENGINE_AUTO}


class TTSEngineError(RuntimeError):
    pass


def resolve_engine_mode(env: dict[str, str] | os._Environ[str] | None = None, generation_cfg: dict | None = None) -> str:
    values = os.environ if env is None else env
    configured = str(
        values.get("TTS_WORKER_ENGINE")
        or (generation_cfg or {}).get("engine")
        or ENGINE_AUTO
    ).strip().lower()
    return configured if configured in ENGINE_MODES else ENGINE_AUTO


def allow_cpu_fallback(env: dict[str, str] | os._Environ[str] | None = None) -> bool:
    values = os.environ if env is None else env
    raw = str(values.get("TTS_WORKER_ALLOW_CPU_FALLBACK", "1")).strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _piper_configured(generation_cfg: dict, env: dict[str, str] | os._Environ[str]) -> bool:
    model = str(env.get("PIPER_MODEL") or generation_cfg.get("piper_model") or "").strip()
    return bool(model)


def create_tts_engine(
    generation_cfg: dict,
    *,
    device: str | None = None,
    env: dict[str, str] | os._Environ[str] | None = None,
    qwen_factory: Callable[..., Any] = QwenCloneEngine,
    piper_factory: Callable[..., Any] = PiperEngine,
) -> tuple[Any, GpuSlot | None]:
    """Pick the GPU engine or the Piper CPU fallback.

    Returns `(engine, gpu_slot)`. The caller owns the returned slot and must
    release it when synthesis ends. Piper runs on CPU and returns no slot.
    """
    values = os.environ if env is None else env
    mode = resolve_engine_mode(values, generation_cfg)
    if mode == ENGINE_PIPER:
        return piper_factory(generation_cfg, device), None

    slot = GpuSlot(
        path=values.get("NEWSROOM_GPU_LOCK_PATH") or None,
        timeout_seconds=_float_env(values.get("NEWSROOM_GPU_LOCK_TIMEOUT_SECONDS"), 3600.0),
        owner="tts-worker",
    )
    slot.acquire()
    try:
        engine = qwen_factory(generation_cfg, device)
        return engine, slot
    except Exception as exc:
        slot.release()
        if mode == ENGINE_QWEN and not allow_cpu_fallback(values):
            raise TTSEngineError(f"Qwen TTS unavailable: {exc}") from exc
        if not _piper_configured(generation_cfg, values):
            if mode == ENGINE_QWEN:
                raise TTSEngineError(f"Qwen TTS unavailable: {exc}") from exc
            raise TTSEngineError(
                f"Qwen TTS unavailable and no Piper fallback configured: {exc}"
            ) from exc
        try:
            fallback = piper_factory(generation_cfg, device)
        except Exception as fallback_exc:
            raise TTSEngineError(
                f"Qwen TTS unavailable ({exc}) and Piper fallback failed: {fallback_exc}"
            ) from fallback_exc
        return fallback, None


def _float_env(value: Any, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default
