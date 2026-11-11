from __future__ import annotations

from pathlib import Path

import pytest

from subtitles_service.infrastructure.translation import SUPPORTED_SOURCE_LANGUAGES
from tests._upload_helpers import TINY_VIDEO_BYTES, make_upload


# A class-scoped guard so we patch MAX_VIDEO_INPUT_BYTES once for the
# oversize test rather than spinning up a second client. The override is
# restored automatically at the end of the module.
@pytest.fixture
def small_size_cap(monkeypatch: pytest.MonkeyPatch) -> int:
    cap = 32
    monkeypatch.setattr(
        "subtitles_service.api.routes.subtitles.MAX_VIDEO_INPUT_BYTES",
        cap,
        raising=False,
    )
    # The import inside the route reads the constant at call time, but the
    # `from ... import ...` line already captured the value at module load.
    # Patch the symbol on the module so the route sees the smaller cap.
    from subtitles_service.api.routes import subtitles as routes_module

    monkeypatch.setattr(routes_module, "MAX_VIDEO_INPUT_BYTES", cap)
    return cap


def _resolve_schema(spec: dict, schema_node: dict) -> dict:
    """Follow a single-level `$ref` pointer into `components.schemas`."""
    ref = schema_node.get("$ref")
    if not ref:
        return schema_node
    assert ref.startswith("#/components/schemas/"), f"unsupported ref: {ref}"
    name = ref.rsplit("/", 1)[-1]
    return spec["components"]["schemas"][name]


def test_openapi_declares_multipart_request_body(client) -> None:
    """The route must expose a `multipart/form-data` requestBody, not query params."""
    spec = client.get("/openapi.json").json()
    operation = spec["paths"]["/api/subtitles/sessions"]["post"]
    request_body = operation.get("requestBody")
    assert request_body is not None, "POST /api/subtitles/sessions must declare a requestBody"
    content = request_body["content"]
    assert "multipart/form-data" in content, (
        f"Expected multipart/form-data, got {list(content)}"
    )
    schema = _resolve_schema(spec, content["multipart/form-data"]["schema"])
    assert "video" in schema["properties"], (
        f"`video` must be a multipart field, got {list(schema['properties'])}"
    )
    # `source_language` and `target_language` are optional form fields, not query params.
    assert "source_language" in schema["properties"]
    assert "target_language" in schema["properties"]
    # `video` is the only required field — language defaults are optional.
    assert schema.get("required", []) == ["video"]
    # None of the upload fields should appear as query parameters.
    assert not any(p["name"] == "video" for p in operation.get("parameters", [])), (
        "`video` must not be a query parameter"
    )
    assert not any(
        p["name"] == "source_language" for p in operation.get("parameters", [])
    ), "`source_language` must not be a query parameter"


def test_create_session_with_multipart_persists_file(
    client, auth_headers, store
) -> None:
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "de"},
        files=make_upload("alemania.mp4"),
    )

    assert response.status_code == 200, response.text
    body = response.json()

    # Frontend contract from `01-Control-Panel/.../controller/session.js`.
    assert "session_id" in body
    assert "status" in body
    assert "preview" in body
    assert body["preview"]["video_url"] == (
        f"/api/subtitles/sessions/{body['session_id']}/preview/video"
    )

    session = body["session"]
    assert session["id"] == body["session_id"]
    assert session["source_language"] == "de"
    assert session["preview_video_path"], "preview_video_path must be set"
    assert session["preview_video_path"].endswith(".mp4")

    # The file must actually be on disk under the session dir.
    session_id = body["session_id"]
    on_disk = Path(session["preview_video_path"])
    assert on_disk.is_file(), f"expected saved file at {on_disk}"
    assert on_disk.read_bytes() == TINY_VIDEO_BYTES

    # Wait for the auto-triggered analyze (background thread) to finish so
    # we can also assert that the snapshot ends up persisted and the
    # session lands in 'analyzed' rather than just 'created'.
    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    # The DB row must reference the same file and the snapshot must exist.
    persisted = store.get_session(session_id)
    assert persisted is not None
    assert persisted["preview_video_path"] == str(on_disk)
    assert persisted["source_language"] == "de"
    assert persisted["status"] == "analyzed"
    assert int(persisted.get("current_snapshot_version") or 0) >= 1


def test_create_session_persists_every_supported_code_1to1(
    client, auth_headers
) -> None:
    """REGRESSION GUARD: every code in `SUPPORTED_SOURCE_LANGUAGES` (the
    single source of truth) must pass through the upload route unchanged.

    Replaces the old bug-pin test that asserted `fr → auto` (silent
    coercion). The new contract is: every Marian + M2M100 + "auto" code
    is honored as-is.
    """
    for code in SUPPORTED_SOURCE_LANGUAGES:
        response = client.post(
            "/api/subtitles/sessions",
            headers=auth_headers,
            data={"source_language": code},
            files=make_upload(f"clip-{code}.mp4"),
        )
        assert response.status_code == 200, (
            f"code={code!r} must be accepted; got {response.status_code}: "
            f"{response.text}"
        )
        body = response.json()
        assert body["session"]["source_language"] == code, (
            f"code={code!r} must persist 1:1; got "
            f"{body['session']['source_language']!r}"
        )


@pytest.mark.parametrize("bad_code", ["xx", "qq", "zz"])
def test_create_session_rejects_unknown_source_language(
    client, auth_headers, bad_code
) -> None:
    """REGRESSION GUARD: any non-empty `source_language` not in
    `SUPPORTED_SOURCE_LANGUAGES` MUST return HTTP 400 with the
    `unsupported_source_language` error envelope (no silent coercion
    to "auto", no 5xx).

    The body is wrapped by FastAPI's `HTTPException(detail=...)` so the
    envelope lives under `body["detail"]["code"]` (consistent with the
    rest of the route's error contract, e.g. the
    `video_input_contract_violation` test).
    """
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": bad_code},
        files=make_upload("clip-bad.mp4"),
    )
    assert response.status_code == 400, response.text
    body = response.json()
    assert body["detail"]["code"] == "unsupported_source_language"
    assert body["detail"]["details"]["received"] == bad_code
    assert body["detail"]["details"]["supported"] == sorted(SUPPORTED_SOURCE_LANGUAGES)
    # 17 codes total: 1 auto + 10 Marian + 6 M2M100.
    assert len(body["detail"]["details"]["supported"]) == 17


def test_create_session_empty_source_language_defaults_to_auto(
    client, auth_headers
) -> None:
    """An empty `source_language` form field defaults to `"auto"` so
    the analyze pipeline can use Whisper's detected language.
    """
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": ""},
        files=make_upload("clip-empty.mp4"),
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["session"]["source_language"] == "auto"


def test_create_session_rejects_invalid_extension(client, auth_headers) -> None:
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.txt", content=b"hello", content_type="text/plain"),
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    assert detail["code"] == "video_input_contract_violation"
    assert ".mp4" in detail["details"]["allowed_extensions"]


def test_create_session_rejects_oversize_file(
    client, auth_headers, small_size_cap, workspace_root
) -> None:
    """A file larger than MAX_VIDEO_INPUT_BYTES must be rejected with a 400
    and the partial file must be removed from disk so we don't leak storage.
    """
    too_big = b"\x00" * (small_size_cap + 16)

    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("big.mp4", content=too_big, content_type="video/mp4"),
    )

    assert response.status_code == 400, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "video_input_contract_violation"
    assert detail["details"]["max_bytes"] == small_size_cap
    assert detail["details"]["received_bytes"] >= small_size_cap

    # No leftover file should remain under the workspace.
    sessions_root = workspace_root / "sessions"
    assert not sessions_root.exists() or not any(sessions_root.rglob("source*")), (
        "partial upload must be cleaned up"
    )


def test_create_session_consumes_body_before_responding(client, auth_headers) -> None:
    """After the response, the same session id's preview endpoint must be
    able to stream the full file back. That proves we wrote the whole body
    before returning to the client.
    """
    payload = b"X" * (128 * 1024)  # 128 KiB — bigger than the read() chunk
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("blob.mp4", content=payload, content_type="video/mp4"),
    )
    assert response.status_code == 200, response.text
    session_id = response.json()["session_id"]

    # Now stream it back through the preview endpoint.
    stream = client.get(
        f"/api/subtitles/sessions/{session_id}/preview/video",
        headers=auth_headers,
    )
    assert stream.status_code == 200, stream.text
    assert stream.content == payload
    assert stream.headers["content-type"].startswith("video/")


def test_create_session_requires_auth(client) -> None:
    response = client.post(
        "/api/subtitles/sessions",
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    assert response.status_code == 401


def test_create_session_accepts_basic_auth(client, basic_auth_headers) -> None:
    response = client.post(
        "/api/subtitles/sessions",
        headers=basic_auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    assert response.status_code == 200, response.text
    assert "session_id" in response.json()


def test_create_session_auto_triggers_analyze(client, auth_headers, store) -> None:
    """The frontend never calls /analyze itself, so the upload route must
    auto-kick the analyze worker. Otherwise the session stays at
    status='created' with current_snapshot_version=0 and the panel polls
    forever stuck in 'Procesando audio'.
    """
    response = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    assert response.status_code == 200, response.text
    body = response.json()

    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, body["session_id"])

    session = store.get_session(body["session_id"])
    assert session is not None
    # The real analyze pipeline marks the session as 'analyzed' and bumps
    # the snapshot version, which is the signal the panel polls for to advance.
    assert session["status"] in {"analyzed", "analyze_failed"}, (
        f"upload did not auto-trigger analyze; got status={session['status']!r}"
    )
    assert int(session.get("current_snapshot_version") or 0) > 0, (
        "analyze must produce a snapshot so the panel can leave 'Procesando audio'"
    )


def test_get_session_returns_flat_shape_panel_can_poll(client, auth_headers, store) -> None:
    """The panel reads `detail.status`, `detail.current_snapshot_version`,
    `detail.preview.video_url`, and `detail.download.ready` directamente off the
    response object. Earlier we wrapped the row in `{"session": ...}` and
    the polling fell back to defaults, leaving the UI stuck on
    'Procesando audio'. This test pins the new flat shape.
    """
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    detail = client.get(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
    ).json()

    # Flat fields used by the polling loop
    assert detail["id"] == session_id
    assert detail["status"] in {"analyzed", "analyze_failed"}
    assert int(detail.get("current_snapshot_version") or 0) > 0
    # Nested objects the panel reads
    assert detail["preview"]["video_url"] == (
        f"/api/subtitles/sessions/{session_id}/preview/video"
    )
    assert "ready" in detail["download"]
    # Make sure we did NOT regress to the old wrapped shape
    assert "session" not in detail


def test_list_sessions_returns_items_envelope(client, auth_headers) -> None:
    """The panel reads `sessions.items` off the list endpoint."""
    client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    payload = client.get(
        "/api/subtitles/sessions?limit=20",
        headers=auth_headers,
    ).json()
    assert "items" in payload
    assert isinstance(payload["items"], list)
    assert len(payload["items"]) >= 1
    assert "preview" in payload["items"][0]
    # Old envelope name must be gone
    assert "sessions" not in payload


def test_get_segments_returns_version_and_segments(client, auth_headers, store) -> None:
    """The panel reads `segments.version` and `segments.segments`."""
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    payload = client.get(
        f"/api/subtitles/sessions/{session_id}/segments",
        headers=auth_headers,
    ).json()
    assert "version" in payload
    assert "segments" in payload
    assert isinstance(payload["segments"], list)
    assert int(payload["version"]) >= 1
    # The fake pipeline returned 2 segments, so the snapshot should have
    # the same rows visible to the panel.
    assert len(payload["segments"]) == 2


def test_health_endpoint_under_api_prefix(client, auth_headers) -> None:
    """The gateway read-model mapping sends /panel/read-models/subtitles/health
    to /api/subtitles/health on this service, so the endpoint must be exposed
    under that exact path (the panel uses it to know the service is online).
    """
    response = client.get(
        "/api/subtitles/health",
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body.get("status") == "ok"


def test_analyze_pipeline_persists_normalized_segments(
    client, auth_headers, store, fake_segments
) -> None:
    """End-to-end: upload -> auto-analyze -> snapshot has real segments.

    The fake pipeline returns the fixture segments and the worker runs the
    full normalize/translate/save dance on a background thread, so by the
    time the polling endpoint replies, the panel-ready shape must include
    those rows in the snapshot.
    """
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    detail = client.get(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
    ).json()
    assert detail["status"] == "analyzed"

    payload = client.get(
        f"/api/subtitles/sessions/{session_id}/segments",
        headers=auth_headers,
    ).json()
    assert int(payload["version"]) == 1
    assert len(payload["segments"]) == len(fake_segments)
    # First segment sanity: starts at 0, has source + translated text.
    first = payload["segments"][0]
    assert first["start_ms"] == 0
    assert first["end_ms"] == 1500
    assert first["source_text"]
    assert first["translated_text"]


def test_delete_session_removes_row_and_file(client, auth_headers, store) -> None:
    """The panel's history rows have a small 'x' that fires
    DELETE /api/subtitles/sessions/{id}. We must accept the call, drop
    the row, and clean up the on-disk session directory so the
    workspace doesn't grow forever.
    """
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    # Wait for the auto-triggered analyze so the job + snapshot rows exist
    # too — the delete path must clean them all.
    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    session = store.get_session(session_id)
    assert session is not None
    preview_path = session.get("preview_video_path")
    assert preview_path and Path(str(preview_path)).is_file()

    response = client.delete(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == {"deleted": True, "session_id": session_id}

    # The row is gone.
    assert store.get_session(session_id) is None
    # And so are the dependent rows.
    assert store.get_latest_job_for_session(session_id, kind="analyze") is None
    assert store.get_latest_snapshot(session_id) is None
    # The session directory and the uploaded video file are gone.
    session_dir = Path(str(preview_path)).parent
    assert not session_dir.exists()
    assert not Path(str(preview_path)).exists()


def test_delete_unknown_session_returns_404(client, auth_headers) -> None:
    response = client.delete(
        "/api/subtitles/sessions/does-not-exist",
        headers=auth_headers,
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "session_not_found"


def test_delete_requires_auth(client) -> None:
    response = client.delete("/api/subtitles/sessions/anything")
    assert response.status_code == 401


def test_rename_session_persists_display_name(client, auth_headers, store) -> None:
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    response = client.patch(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
        json={"display_name": "Allemanya demo"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["display_name"] == "Allemanya demo"
    assert body["id"] == session_id

    # The DB row also reflects the new name.
    persisted = store.get_session(session_id)
    assert persisted["display_name"] == "Allemanya demo"

    # The list endpoint also surfaces it.
    listing = client.get(
        "/api/subtitles/sessions?limit=20",
        headers=auth_headers,
    ).json()
    matching = [item for item in listing["items"] if item["id"] == session_id]
    assert matching and matching[0]["display_name"] == "Allemanya demo"


def test_rename_session_with_blank_string_clears_name(client, auth_headers) -> None:
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    # Set, then clear.
    client.patch(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
        json={"display_name": "with name"},
    )
    response = client.patch(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
        json={"display_name": "   "},
    )
    assert response.status_code == 200, response.text
    assert response.json()["display_name"] is None


def test_rename_session_404_for_unknown(client, auth_headers) -> None:
    response = client.patch(
        "/api/subtitles/sessions/does-not-exist",
        headers=auth_headers,
        json={"display_name": "ghost"},
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "session_not_found"


def test_rename_session_rejects_non_string_payload(client, auth_headers) -> None:
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]
    response = client.patch(
        f"/api/subtitles/sessions/{session_id}",
        headers=auth_headers,
        json={"display_name": 42},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "input_contract_violation"


def test_render_status_returns_job_and_download_envelopes(client, auth_headers) -> None:
    """The panel reads payload.job.status and payload.download.ready."""
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    payload = client.get(
        f"/api/subtitles/sessions/{session_id}/render",
        headers=auth_headers,
    ).json()
    assert "job" in payload and "status" in payload["job"]
    assert "download" in payload and "ready" in payload["download"]


def test_render_404_for_unknown_session(client, auth_headers) -> None:
    response = client.post(
        "/api/subtitles/sessions/does-not-exist/render",
        headers=auth_headers,
        json={"base_version": 0},
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "session_not_found"


def test_render_409_when_no_snapshot(client, auth_headers, store) -> None:
    """Render must fail with 409 (render_not_ready) when no analyze snapshot
    exists. We trigger that branch by deleting the auto-created snapshot
    rows directly through a fresh SubtitleStore pointing at the same
    workspace_root the app uses.
    """
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    from tests.conftest import _wait_for_analyze
    _wait_for_analyze(store, session_id)

    # Open a parallel connection against the same SQLite file and clear
    # the snapshot that the auto-trigger wrote.
    import sqlite3
    from pathlib import Path
    db_path = Path(store.db_path)
    with sqlite3.connect(str(db_path)) as conn:
        conn.execute("DELETE FROM snapshots WHERE session_id = ?", (session_id,))

    response = client.post(
        f"/api/subtitles/sessions/{session_id}/render",
        headers=auth_headers,
        json={"base_version": 0},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "render_not_ready"


def test_download_file_returns_404_before_render(client, auth_headers) -> None:
    """A user can poll the download envelope and the file endpoint and
    both report 'not ready' until the render actually finishes.
    """
    create = client.post(
        "/api/subtitles/sessions",
        headers=auth_headers,
        data={"source_language": "en"},
        files=make_upload("clip.mp4"),
    )
    session_id = create.json()["session_id"]

    # Don't trigger a render. The session is auto-analyzed but never rendered,
    # so the artifact is missing and the file endpoint should 400.
    download = client.get(
        f"/api/subtitles/sessions/{session_id}/download",
        headers=auth_headers,
    ).json()
    assert download["ready"] is False
    assert download["url"] == ""

    file_resp = client.get(
        f"/api/subtitles/sessions/{session_id}/download/file",
        headers=auth_headers,
    )
    assert file_resp.status_code == 400
    detail = file_resp.json()["detail"]
    assert detail["code"] == "render_not_ready"
