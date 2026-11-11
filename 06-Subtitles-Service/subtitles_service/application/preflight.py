from __future__ import annotations

from pathlib import Path


def run_preflight_checks(
    workspace_root: Path,
) -> dict[str, bool]:
    """Run preflight checks to ensure the service is ready.

    Returns a dict of check names to their status.
    """
    checks = {
        "workspace_exists": workspace_root.exists(),
        "ffmpeg_available": _check_ffmpeg(),
        "node_available": _check_node(),
        "remotion_available": _check_remotion(workspace_root),
    }
    return checks


def _check_ffmpeg() -> bool:
    """Check if ffmpeg is available."""
    import shutil
    return shutil.which("ffmpeg") is not None


def _check_node() -> bool:
    """Check if node is available."""
    import shutil
    return shutil.which("node") is not None


def _check_remotion(workspace_root: Path) -> bool:
    """Check if Remotion is available."""
    remotion_dir = workspace_root / "node_modules" / ".remotion"
    return remotion_dir.exists()
