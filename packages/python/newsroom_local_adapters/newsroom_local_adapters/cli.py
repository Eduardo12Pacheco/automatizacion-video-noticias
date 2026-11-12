"""JSON command line used by `packages/adapters`.

Commands:
  extract <url>        fetch an article with trafilatura and return its main text
  create-doc           read a JSON payload on stdin and write a .docx + .md pair

Every command writes one JSON object to stdout. Failures write a JSON object
with an `error` code/message to stderr and exit with a non-zero status so the
Node adapter can surface a typed error instead of parsing tracebacks.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _slug(value: str, *, limit: int = 80) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:limit] or "guion"


def _document_id(payload: dict[str, Any]) -> str:
    seed = "|".join(
        [
            str(payload.get("draftId") or ""),
            str(payload.get("title") or ""),
            str(payload.get("content") or "")[:500],
            datetime.now(timezone.utc).date().isoformat(),
        ]
    )
    return "doc-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:20]


def _download_html(url: str, *, timeout_seconds: float = 30.0) -> str:
    """Fetch a public article page with the standard library.

    trafilatura's own downloader returns None for some local/LAN hosts and for
    servers that only understand simple requests. Fetching here keeps the
    extractor working against the local panel fixtures and against ordinary
    public pages alike; the extraction step stays in trafilatura.
    """
    from urllib.parse import urlparse
    from urllib.request import Request, urlopen

    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("trafilatura_invalid_url")
    request = Request(url, headers={"user-agent": "newsroom-local-extractor/1.0", "accept": "text/html,*/*"})
    with urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - explicit http(s) guard above
        return response.read().decode("utf-8", errors="replace")


def extract_article(url: str) -> dict[str, Any]:
    try:
        import trafilatura
    except ImportError as exc:  # pragma: no cover - depends on the host install
        raise RuntimeError("trafilatura_unavailable") from exc

    try:
        downloaded = _download_html(url)
    except Exception:
        downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise RuntimeError("trafilatura_fetch_failed")
    raw = trafilatura.extract(
        downloaded,
        output_format="json",
        with_metadata=True,
        include_comments=False,
        include_tables=False,
        favor_precision=True,
    )
    if not raw:
        raise RuntimeError("trafilatura_extract_failed")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("trafilatura_invalid_json") from exc
    main_content = str(parsed.get("text") or parsed.get("raw_text") or "").strip()
    if not main_content:
        raise RuntimeError("trafilatura_empty_content")
    return {
        "url": str(parsed.get("url") or url),
        "title": str(parsed.get("title") or "").strip(),
        "subtitle": str(parsed.get("description") or "").strip(),
        "author": str(parsed.get("author") or "").strip(),
        "published_at": str(parsed.get("date") or "").strip(),
        "main_content": main_content,
        "extractor": "trafilatura",
    }


def _write_docx(path: Path, *, title: str, content: str, pronunciation: str) -> None:
    from docx import Document
    from docx.shared import Pt

    document = Document()
    style = document.styles["Normal"]
    style.font.name = "Inter"
    style.font.size = Pt(11)
    document.add_heading(title or "Guion", level=1)
    for block in re.split(r"\n\s*\n", content or ""):
        text = block.strip()
        if text:
            document.add_paragraph(text)
    if pronunciation and pronunciation.strip() and pronunciation.strip() != (content or "").strip():
        document.add_page_break()
        document.add_heading("Pronunciación para locución", level=2)
        for block in re.split(r"\n\s*\n", pronunciation):
            text = block.strip()
            if text:
                document.add_paragraph(text)
    document.save(path)


def create_document(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        import docx  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on the host install
        raise RuntimeError("python_docx_unavailable") from exc

    root = Path(str(payload.get("root") or "data/documents")).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    doc_id = _document_id(payload)
    title = str(payload.get("title") or "Guion").strip() or "Guion"
    content = str(payload.get("content") or "").strip()
    pronunciation = str(payload.get("pronunciation") or "").strip()
    if not content:
        raise RuntimeError("document_content_empty")

    docx_path = root / f"{doc_id}.docx"
    markdown_path = root / f"{doc_id}.md"
    _write_docx(docx_path, title=title, content=content, pronunciation=pronunciation)
    markdown = [f"# {title}", "", content]
    if pronunciation and pronunciation != content:
        markdown.extend(["", "## Pronunciación para locución", "", pronunciation])
    markdown_path.write_text("\n".join(markdown).rstrip() + "\n", encoding="utf-8")
    filename = f"{_slug(title)}.docx"
    metadata = {
        "doc_id": doc_id,
        "doc_url": f"/panel/documents/{doc_id}.docx",
        "filename": filename,
        "content_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx_path": str(docx_path),
        "markdown_path": str(markdown_path),
    }
    (root / f"{doc_id}.json").write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
    return metadata


def _read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("payload_must_be_object")
    return parsed


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    try:
        if not args:
            raise RuntimeError("missing_command")
        command = args[0]
        if command == "extract":
            if len(args) < 2 or not args[1].strip():
                raise RuntimeError("missing_url")
            result = extract_article(args[1].strip())
        elif command == "create-doc":
            result = create_document(_read_payload())
        else:
            raise RuntimeError(f"unknown_command:{command}")
    except Exception as exc:  # noqa: BLE001 - the CLI contract is JSON, not tracebacks
        code = str(exc) or "adapter_failure"
        print(json.dumps({"error": code, "message": code}), file=sys.stderr)
        return 3
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
