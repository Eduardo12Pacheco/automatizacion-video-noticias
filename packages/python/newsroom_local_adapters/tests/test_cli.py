from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from newsroom_local_adapters.cli import create_document, extract_article


def test_create_document_writes_docx_and_markdown(tmp_path: Path):
    result = create_document(
        {
            "draftId": "draft-news-1",
            "title": "Guion - Jugador - Tema",
            "content": "Primer parrafo.\n\nSegundo parrafo.",
            "pronunciation": "Primer parrafo con fonetica.",
            "root": str(tmp_path),
        }
    )

    assert result["doc_id"].startswith("doc-")
    assert result["content_type"].endswith("wordprocessingml.document")
    docx_path = Path(result["docx_path"])
    markdown_path = Path(result["markdown_path"])
    assert docx_path.is_file() and docx_path.stat().st_size > 0
    assert docx_path.read_bytes().startswith(b"PK")
    assert markdown_path.read_text(encoding="utf-8").startswith("# Guion - Jugador - Tema")
    assert "Pronunciación para locución" in markdown_path.read_text(encoding="utf-8")


def test_create_document_rejects_empty_content(tmp_path: Path):
    with pytest.raises(RuntimeError, match="document_content_empty"):
        create_document({"title": "Vacio", "content": "", "root": str(tmp_path)})


def test_cli_unknown_command_returns_json_error():
    completed = subprocess.run(
        [sys.executable, "-m", "newsroom_local_adapters.cli", "unknown"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode != 0
    payload = json.loads(completed.stderr.strip())
    assert payload["error"] == "unknown_command:unknown"


@pytest.mark.live
@pytest.mark.skipif(os.environ.get("NEWSROOM_LIVE_TESTS") != "1", reason="set NEWSROOM_LIVE_TESTS=1 to run the live trafilatura check")
def test_live_trafilatura_extracts_a_public_article():
    pytest.importorskip("trafilatura")
    article = extract_article("https://example.com/")

    assert article["main_content"]
    assert article["extractor"] == "trafilatura"
