from __future__ import annotations

import io


# Tiny 1-byte "mp4" payload — not a valid video, but it's enough to exercise
# the upload plumbing. The route doesn't decode the file, it just streams it
# to disk and validates extension + size.
TINY_VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"


def make_upload(
    filename: str,
    content: bytes = TINY_VIDEO_BYTES,
    content_type: str = "video/mp4",
) -> dict[str, tuple[str, io.BytesIO, str]]:
    """Build a `files=` dict for `TestClient.post` mimicking a multipart upload."""
    return {"video": (filename, io.BytesIO(content), content_type)}
