from __future__ import annotations

from pathlib import Path
from typing import Any


def run_legacy_cli(
    session_dir: Path,
    source_video_path: Path,
    **kwargs: Any,
) -> Path:
    """Run the legacy CLI pipeline for backward compatibility.

    Returns the path to the rendered video.
    """
    # TODO: Implement legacy CLI pipeline
    # This is for backward compatibility with the old command-line interface

    # Placeholder implementation
    return session_dir / "video-final.mp4"
