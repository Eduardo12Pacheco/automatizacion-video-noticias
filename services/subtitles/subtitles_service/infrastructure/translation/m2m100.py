from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from subtitles_service.domain.errors import ErrorCode, PipelineError


class M2M100Translator:
    """Lazy wrapper around `M2M100ForConditionalGeneration` from `transformers`.

    Used as a fallback for the 6 source languages that have no Marian MT
    model on disk (pt, cs, gd, tr, tzm, uz). The model is heavy (~1.7 GB
    on disk, several GB in RAM), so we:

    * validate the model directory exists at construction time (raises
      `M2M100_MODEL_NOT_FOUND` so the route can surface a 503 early),
    * lazy-load the tokenizer + model on the first `translate()` call,
    * serialize concurrent M2M100 calls via a class-level lock to bound
      RAM under load (one in-flight M2M100 job at a time per process).

    `translate(segments, target="es")` reads the source language from
    `segments[0]["__source_lang__"]` (the pipeline tags each segment
    with that key before calling), then forces Spanish as the target
    language via `forced_bos_token_id = tokenizer.get_lang_id(target)`.

    Returns a list of dicts with `text`, `translated_text`, `source_text`,
    `start_ms`, `end_ms` — same shape as `OpusMtTranslator.translate()`
    so the pipeline can call either one interchangeably.
    """

    # Serialize concurrent M2M100 calls (M2M100 is RAM-bound; one at a time).
    _LOCK = threading.Lock()

    def __init__(self, model_dir: Path | str) -> None:
        model_dir_path = Path(model_dir)
        if not model_dir_path.is_dir():
            raise PipelineError(
                code=ErrorCode.M2M100_MODEL_NOT_FOUND,
                message=f"M2M100 model directory not found: {model_dir_path}",
                details={
                    "model": str(model_dir_path),
                    "hint": "M2M100_MODEL_NOT_FOUND",
                },
            )
        self.model_dir = str(model_dir_path)
        # Lazy state — populated on first call to `_load()`.
        self._tokenizer: Any | None = None
        self._model: Any | None = None
        self._device: str = "cpu"

    def _load(self):
        """Lazy-load the tokenizer + model. Holds `_LOCK` only while
        populating; subsequent calls reuse the cached instances.
        """
        if self._model is not None and self._tokenizer is not None:
            return self._model, self._tokenizer, self._device

        with self._LOCK:
            # Re-check inside the lock in case another thread loaded it
            # while we were waiting.
            if self._model is not None and self._tokenizer is not None:
                return self._model, self._tokenizer, self._device

            try:
                from transformers import (
                    M2M100ForConditionalGeneration,
                    M2M100Tokenizer,
                )
                import torch
            except ImportError as exc:
                raise PipelineError(
                    code=ErrorCode.M2M100_MODEL_NOT_FOUND,
                    message=(
                        "transformers/torch not installed; cannot load M2M100"
                    ),
                    details={"hint": "pip install transformers sentencepiece torch"},
                ) from exc

            try:
                self._tokenizer = M2M100Tokenizer.from_pretrained(self.model_dir)
                self._model = M2M100ForConditionalGeneration.from_pretrained(
                    self.model_dir
                )
                self._device = "cuda" if torch.cuda.is_available() else "cpu"
                self._model.to(self._device)
            except Exception as exc:
                raise PipelineError(
                    code=ErrorCode.M2M100_MODEL_NOT_FOUND,
                    message=(
                        f"Could not load M2M100 model '{self.model_dir}': {exc}"
                    ),
                    details={
                        "model": self.model_dir,
                        "hint": "M2M100_MODEL_NOT_FOUND",
                    },
                ) from exc

        return self._model, self._tokenizer, self._device

    def translate(
        self,
        segments: list[dict[str, Any]],
        target: str = "es",
    ) -> list[dict[str, Any]]:
        """Translate `segments` into `target` (default: Spanish).

        Each input segment MUST be a dict carrying at least `text` and
        `__source_lang__` (the pipeline tags segments with the source
        language before calling). Returns a list of dicts with the same
        shape as `OpusMtTranslator.translate()`:

            {
                "text": <original text>,
                "translated_text": <Spanish text>,
                "source_text": <original text>,
                "start_ms": <int>,
                "end_ms": <int>,
            }

        `translate([])` returns `[]` without touching the model.
        """
        if not segments:
            return []

        # Source language is per-batch (M2M100 only does one src at a time).
        # The pipeline guarantees all segments in the call share the same
        # `__source_lang__`; we read it off the first segment.
        source = segments[0].get("__source_lang__") or segments[0].get(
            "source_language"
        )
        if not source:
            raise PipelineError(
                code=ErrorCode.TRANSLATION_FAILED,
                message=(
                    "M2M100Translator.translate() requires segments to carry "
                    "'__source_lang__' (set by the analyze pipeline)"
                ),
                details={"received_keys": list(segments[0].keys())},
            )

        model, tokenizer, device = self._load()
        tokenizer.src_lang = str(source)
        forced_bos_token_id = tokenizer.get_lang_id(target)

        texts = [seg["text"] for seg in segments]

        # Serialize M2M100 calls — keep peak RAM bounded.
        with self._LOCK:
            try:
                import torch

                with torch.no_grad():
                    encoded = tokenizer(
                        texts,
                        return_tensors="pt",
                        padding=True,
                        truncation=True,
                        max_length=512,
                    ).to(device)
                    generated = model.generate(
                        **encoded,
                        forced_bos_token_id=forced_bos_token_id,
                        max_new_tokens=256,
                        num_beams=2,
                        early_stopping=True,
                    )
                decoded = tokenizer.batch_decode(
                    generated, skip_special_tokens=True
                )
            except Exception as exc:
                raise PipelineError(
                    code=ErrorCode.TRANSLATION_FAILED,
                    message=f"M2M100 translation failed: {exc}",
                    details={"source": str(source), "target": str(target)},
                ) from exc

        out: list[dict[str, Any]] = []
        for raw, es in zip(segments, decoded):
            out.append(
                {
                    "text": raw["text"],
                    "translated_text": es.strip(),
                    "source_text": raw["text"],
                    "start_ms": int(raw.get("start_ms", 0)),
                    "end_ms": int(raw.get("end_ms", 1)),
                }
            )
        return out


__all__ = ["M2M100Translator"]
