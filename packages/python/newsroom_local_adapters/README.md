# newsroom-local-adapters

Local helper process used by `packages/adapters` for the two capability ports
that have a mature Python implementation:

- **trafilatura** for article fetch + main-text extraction (replaces the former cloud scraper),
- **python-docx** for the `.docx` export (the adapter also writes a Markdown
  copy next to it).

It is a plain JSON CLI, not a service: the Node API spawns it on demand with
the configured `PYTHON_BIN`, so no extra port or container is needed.

```sh
uv run --with trafilatura --with python-docx pytest tests -q
uv run --with trafilatura --with python-docx python -m newsroom_local_adapters.cli extract https://example.com/
```

Tests marked `live` need network access and are skipped by default:

```sh
NEWSROOM_LIVE_TESTS=1 uv run --with trafilatura --with python-docx pytest tests -q -m live
```
