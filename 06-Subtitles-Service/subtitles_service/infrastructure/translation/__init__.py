from __future__ import annotations

# Single source of truth for the source-language allow-list.
#
# The route layer (`api/routes/subtitles.py`) MUST consult this constant
# instead of a local set literal. The pipeline resolver (below) uses the
# same set to decide Marian-first / M2M100-fallback / hard-fail.
#
# Today the union is:
#   * 10 Marian codes: en, de, fr, it, ca, ko, ar, ber, pap, nl
#   *  6 M2M100 codes: pt, cs, gd, tr, tzm, uz
#   *  1 literal "auto" (means: use Whisper's detected language)
from subtitles_service.infrastructure.translation.opus_mt import (
    OPUS_MT_SUPPORTED,
    OpusMtTranslator,
    UNSUPPORTED_SOURCE_LANGUAGE,
    resolve_translator_for_source as _resolve_opus_for_source,
)


# Languages M2M100_418M can translate from (no Marian model exists for them).
# M2M100 is many-to-many; here we constrain to the languages the panel
# documents so the route can validate before the pipeline ever runs.
M2M100_SUPPORTED: frozenset[str] = frozenset(
    {"pt", "cs", "gd", "tr", "tzm", "uz"}
)


SUPPORTED_SOURCE_LANGUAGES: frozenset[str] = frozenset(
    {"auto"} | OPUS_MT_SUPPORTED | M2M100_SUPPORTED
)


def resolve_translator_for_source(
    effective_source: str,
    target: str = "es",
):
    """Pick the right translator: Marian first, M2M100 as fallback, else raise.

    `effective_source` is the ISO 639-1 code to translate FROM (e.g. `"fr"`,
    `"pt"`). It must already be normalized (e.g. by
    `infrastructure/asr/whisper_asr.py::normalize_to_iso639_1`).

    Returns a translator with a `translate(segments, target=...)` method
    matching the unified interface.

    Raises `UNSUPPORTED_SOURCE_LANGUAGE` (a `PipelineError`) if neither
    Marian nor M2M100 has a model for the requested code.
    """
    code = (effective_source or "").strip().lower()
    if code in OPUS_MT_SUPPORTED:
        return _resolve_opus_for_source(code)
    if code in M2M100_SUPPORTED:
        # Lazy import — M2M100 pulls in `transformers` + `torch`, keep it
        # out of the import-time graph for callers that only need Marian.
        from subtitles_service.config.contracts import M2M100_MODEL_DIR
        from subtitles_service.infrastructure.translation.m2m100 import (
            M2M100Translator,
        )
        return M2M100Translator(model_dir=M2M100_MODEL_DIR)
    raise UNSUPPORTED_SOURCE_LANGUAGE(
        f"Unsupported source language: {effective_source!r}",
        details={
            "received": effective_source,
            "supported": sorted(SUPPORTED_SOURCE_LANGUAGES),
        },
    )


__all__ = [
    "OPUS_MT_SUPPORTED",
    "M2M100_SUPPORTED",
    "SUPPORTED_SOURCE_LANGUAGES",
    "UNSUPPORTED_SOURCE_LANGUAGE",
    "OpusMtTranslator",
    "resolve_translator_for_source",
]
