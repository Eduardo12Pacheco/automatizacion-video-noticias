from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Fakes for `transformers` so we never load a real model in the unit test.
# The translator imports `transformers` lazily inside `_load()`, so we patch
# the module's symbol table once and then import the translator module.
# ---------------------------------------------------------------------------


class _FakeTokenizer:
    """Bare minimum: src_lang attr + get_lang_id(target) -> int."""

    def __init__(self, lang_id_map: dict[str, int] | None = None) -> None:
        self.src_lang = ""
        self._map = lang_id_map or {"es": 12_345}
        # Standard HF tokenizer protocol bits used by the translator.
        self.padding_side = "right"

    def get_lang_id(self, lang: str) -> int:
        return self._map.get(lang, 99_999)

    def __call__(self, texts, **_kwargs):
        return _FakeEncoding(texts)

    def batch_decode(self, generated, skip_special_tokens: bool = True):
        # `generated` is a list-like of ints per item. We just round-trip
        # the original text via a sentinel; the real model would decode
        # token ids to Spanish. The test asserts the call shape, not the
        # exact Spanish output.
        out = []
        n = len(generated) if hasattr(generated, "__len__") else 1
        for i in range(n):
            out.append(f"<es:{i}>")
        return out


class _FakeEncoding(dict):
    """Mimics HF `BatchEncoding`: a dict carrying `input_ids` etc. that
    can be unpacked with `**` into `model.generate()`.
    """

    def __init__(self, texts) -> None:
        super().__init__(input_ids=[[0, 1] for _ in texts])

    def to(self, _device) -> "_FakeEncoding":
        return self


class _FakeModel:
    def __init__(self) -> None:
        self.generate_calls: list[dict[str, Any]] = []

    def to(self, _device) -> "_FakeModel":
        return self

    def generate(self, **kwargs):
        self.generate_calls.append(kwargs)
        # Return a list of fake token-id sequences, one per input.
        n = len(self.generate_calls[-1].get("input_ids", []))
        return [[0, 1, 2] for _ in range(n)]


def _install_fake_transformers(monkeypatch) -> tuple[_FakeTokenizer, _FakeModel]:
    """Inject a fake `transformers` module so `M2M100Translator._load()`
    imports succeed and we can introspect the call shape.
    """
    fake_module = types.ModuleType("transformers")
    tokenizer_instance = _FakeTokenizer({"es": 12_345})
    model_instance = _FakeModel()
    fake_module.M2M100Tokenizer = types.SimpleNamespace(
        from_pretrained=lambda *_args, **_kwargs: tokenizer_instance
    )
    fake_module.M2M100ForConditionalGeneration = types.SimpleNamespace(
        from_pretrained=lambda *_args, **_kwargs: model_instance
    )
    monkeypatch.setitem(sys.modules, "transformers", fake_module)
    return tokenizer_instance, model_instance


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_constructor_raises_when_model_dir_missing(tmp_path: Path) -> None:
    """`M2M100_MODEL_NOT_FOUND` is raised when the model directory is not
    on disk at construction time, so the route can surface a 503 instead
    of waiting for a lazy-load to fail later in the pipeline.
    """
    from subtitles_service.infrastructure.translation.m2m100 import (
        M2M100Translator,
    )

    missing = tmp_path / "does-not-exist-m2m100"
    assert not missing.exists()

    with pytest.raises(Exception) as exc_info:
        M2M100Translator(model_dir=missing)

    # The error is a `PipelineError` carrying the right code/hint.
    err = exc_info.value
    # It must be a `PipelineError` (the import path inside the module matters).
    from subtitles_service.domain.errors import ErrorCode, PipelineError

    assert isinstance(err, PipelineError), (
        f"expected PipelineError, got {type(err).__name__}"
    )
    assert err.code == ErrorCode.M2M100_MODEL_NOT_FOUND
    assert err.details.get("hint") == "M2M100_MODEL_NOT_FOUND"
    assert str(missing) in (err.details.get("model") or err.message)


def test_translate_happy_path_calls_generate_with_forced_bos(
    monkeypatch, tmp_path: Path
) -> None:
    """`translate()` should set `tokenizer.src_lang`, call `model.generate`
    with `forced_bos_token_id=tokenizer.get_lang_id('es')`, and emit a
    segment carrying `text`, `translated_text`, `source_text`, plus
    preserved `start_ms` / `end_ms` from the input.
    """
    torch = pytest.importorskip(
        "torch",
        reason=(
            "torch is not installed locally; CI installs the "
            "services/subtitles[translation] extra so this test runs there"
        ),
    )
    assert torch is not None
    tokenizer, model = _install_fake_transformers(monkeypatch)

    from subtitles_service.infrastructure.translation.m2m100 import (
        M2M100Translator,
    )

    translator = M2M100Translator(model_dir=tmp_path)
    out = translator.translate(
        [
            {
                "text": "bonjour",
                "__source_lang__": "fr",
                "start_ms": 0,
                "end_ms": 1000,
            }
        ]
    )

    assert len(out) == 1
    seg = out[0]
    assert seg["text"] == "bonjour"
    assert seg["source_text"] == "bonjour"
    assert seg["translated_text"], "translated_text must be non-empty"
    assert seg["start_ms"] == 0
    assert seg["end_ms"] == 1000

    # The translator must have set src_lang and used the correct forced_bos id.
    assert tokenizer.src_lang == "fr"
    assert len(model.generate_calls) == 1
    call = model.generate_calls[0]
    assert call["forced_bos_token_id"] == tokenizer.get_lang_id("es")


def test_translate_empty_segments_returns_empty_list(
    monkeypatch, tmp_path: Path
) -> None:
    """`translate([])` must short-circuit and return `[]` without ever
    touching the model — M2M100 loads are expensive and must not happen
    for an empty batch.
    """
    _install_fake_transformers(monkeypatch)

    from subtitles_service.infrastructure.translation.m2m100 import (
        M2M100Translator,
    )

    translator = M2M100Translator(model_dir=tmp_path)
    out = translator.translate([])
    assert out == []
