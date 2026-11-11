from __future__ import annotations

import os
import threading
from typing import Iterable, Protocol

from subtitles_service.domain.errors import ErrorCode, PipelineError


class UNSUPPORTED_SOURCE_LANGUAGE(PipelineError):
    """Raised when the effective source language has no Marian or M2M100 model.

    Subclass of `PipelineError` so existing `try/except PipelineError` blocks
    keep working; the route layer maps this to HTTP 400.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        super().__init__(
            code=ErrorCode.MODEL_NOT_AVAILABLE,
            message=message,
            details={"hint": "UNSUPPORTED_SOURCE_LANGUAGE", **(details or {})},
        )


class TranslationModel(Protocol):
    def translate_batch(self, texts: list[str]) -> list[str]: ...


class OpusMtTranslator:
    """Lazy MarianMT (Helsinki-NLP/Opus-MT) wrapper.

    `model_name_or_path` is a local path to the opus-mt-XX-es model on disk
    (e.g. C:/.../local/models/opus-mt-en-es). Loading is deferred to the
    first call so the upload handler stays snappy.
    """

    _LOCK = threading.Lock()
    _INSTANCE: "OpusMtTranslator | None" = None

    def __init__(self, model_name_or_path: str) -> None:
        self.model_name_or_path = model_name_or_path
        self._tokenizer = None
        self._model = None
        self._device = "cpu"

    @classmethod
    def default(cls) -> "OpusMtTranslator":
        from subtitles_service.config.contracts import TRANSLATION_MODEL_DIR
        return cls(model_name_or_path=os.getenv("SUBS_MT_EN_ES_MODEL") or str(TRANSLATION_MODEL_DIR))

    def _load(self):
        if self._model is None:
            with self._LOCK:
                if self._model is None:
                    try:
                        import torch
                        from transformers import MarianMTModel, MarianTokenizer
                    except ImportError as exc:
                        raise PipelineError(
                            ErrorCode.MODEL_NOT_AVAILABLE,
                            "transformers/torch not installed",
                            {"hint": "pip install transformers sentencepiece torch"},
                        ) from exc
                    try:
                        self._tokenizer = MarianTokenizer.from_pretrained(self.model_name_or_path)
                        self._model = MarianMTModel.from_pretrained(self.model_name_or_path)
                        self._device = "cuda" if torch.cuda.is_available() else "cpu"
                        self._model.to(self._device)
                    except Exception as exc:
                        raise PipelineError(
                            ErrorCode.MODEL_NOT_AVAILABLE,
                            f"Could not load translation model '{self.model_name_or_path}': {exc}",
                            {"model": self.model_name_or_path},
                        ) from exc
        return self._model, self._tokenizer, self._device

    def translate_batch(self, texts: list[str]) -> list[str]:
        if not texts:
            return []
        model, tokenizer, device = self._load()
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
                    max_new_tokens=256,
                    num_beams=2,
                    early_stopping=True,
                )
            decoded = tokenizer.batch_decode(generated, skip_special_tokens=True)
        except Exception as exc:
            raise PipelineError(
                ErrorCode.TRANSLATION_FAILED,
                f"Opus-MT translation failed: {exc}",
            ) from exc
        return [text.strip() for text in decoded]

    def translate(
        self,
        segments: list[dict],
        target: str = "es",
    ) -> list[dict]:
        """Unified translator interface (matches `M2M100Translator`).

        Wraps the existing `translate_batch` and emits a list of dicts
        with `text`, `translated_text`, `source_text`, `start_ms`,
        `end_ms`. The pipeline uses this method regardless of which
        translator is in play (Marian or M2M100).

        `target` is accepted for interface compatibility with the M2M100
        translator; Marian MT models are pinned to a single target
        language (es) at construction time, so this argument is
        effectively ignored.
        """
        if not segments:
            return []
        texts = [seg["text"] for seg in segments]
        decoded = self.translate_batch(texts)
        out: list[dict] = []
        for raw, es in zip(segments, decoded):
            out.append(
                {
                    "text": raw["text"],
                    "translated_text": es,
                    "source_text": raw["text"],
                    "start_ms": int(raw.get("start_ms", 0)),
                    "end_ms": int(raw.get("end_ms", 1)),
                }
            )
        return out


# Map the panel's source_language value to the local opus-mt model folder.
# The workspace already ships opus-mt-{en,de,fr,it,ca,ko,ar,ber,pap,nl}-es.
_OPUS_MT_LANG_DIRS = {
    "en": "opus-mt-en-es",
    "de": "opus-mt-de-es",
    "fr": "opus-mt-fr-es",
    "it": "opus-mt-it-es",
    "ca": "opus-mt-ca-es",
    "ko": "opus-mt-ko-es",
    "ar": "opus-mt-ar-es",
    "ber": "opus-mt-ber-es",
    "pap": "opus-mt-pap-es",
    "nl": "opus-mt-nl-es",
}


# Public frozenset: the codes whose translations exist as Marian MT models
# on disk. Exposed via `infrastructure/translation/__init__.py` together
# with the M2M100 set so the route layer has a single source of truth.
OPUS_MT_SUPPORTED: frozenset[str] = frozenset(_OPUS_MT_LANG_DIRS.keys())


def resolve_translator_for_source(source_language: str) -> OpusMtTranslator:
    """Pick the right local opus-mt model based on the requested source
    language. Falls back to the en-es default for unknown values.

    NOTE: callers that need a unified Marian-or-M2M100 resolver should use
    `resolve_translator_for_source_v2` (defined in `__init__.py`) which
    routes Marian first / M2M100 fallback / hard-fail otherwise. This thin
    helper is preserved for legacy callers that only need Marian.
    """
    from subtitles_service.config.contracts import SHARED_MODELS_DIR
    folder = _OPUS_MT_LANG_DIRS.get((source_language or "").strip().lower())
    if not folder:
        folder = _OPUS_MT_LANG_DIRS["en"]
    model_path = SHARED_MODELS_DIR / folder
    if model_path.exists():
        return OpusMtTranslator(model_name_or_path=str(model_path))
    # Last resort: the default en-es model.
    return OpusMtTranslator.default()


__all__ = [
    "OpusMtTranslator",
    "OPUS_MT_SUPPORTED",
    "UNSUPPORTED_SOURCE_LANGUAGE",
    "resolve_translator_for_source",
]
