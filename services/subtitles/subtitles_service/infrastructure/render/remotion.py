from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from subtitles_service.config.contracts import ROOT_DIR
from subtitles_service.domain.errors import ErrorCode, PipelineError, map_os_error_to_pipeline_error
from subtitles_service.domain.style import build_render_subtitles_payload
from subtitles_service.storage.json_io import write_json


def probe_nvenc_capability() -> dict[str, str | bool | None]:
    command = ["ffmpeg", "-hide_banner", "-encoders"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        return {"available": False, "encoder": None, "reason": str(error)}
    stdout = str(getattr(result, "stdout", "") or "")
    encoder = "h264_nvenc" if "h264_nvenc" in stdout else None
    return {"available": encoder is not None, "encoder": encoder, "reason": "ok" if encoder else "missing h264_nvenc encoder"}


def _validate_output_contract(render_props_path: Path) -> None:
    payload = json.loads(render_props_path.read_text(encoding="utf-8"))
    background = str(payload.get("background") or "").strip().lower()
    if background != "#000000":
        raise PipelineError(
            ErrorCode.ARTIFACT_VALIDATION_FAILED,
            "Prototype output contract requires black background",
            {"background": payload.get("background")},
        )


def _probe_video_codec(video_path: Path) -> str:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise PipelineError(
            ErrorCode.ARTIFACT_VALIDATION_FAILED,
            "Could not probe rendered codec",
            {"stderr": result.stderr.strip()},
        )
    return str(result.stdout or "").strip().lower()


def run_render(
    render_props_path: Path,
    output_video_path: Path,
    include_evidence: bool = False,
) -> Path | tuple[Path, dict[str, str | bool | None]]:
    nvenc = probe_nvenc_capability()
    _validate_output_contract(render_props_path)
    script_path = ROOT_DIR / "scripts" / "render-video.js"
    command = ["node", str(script_path), "--props", str(render_props_path), "--output", str(output_video_path)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise map_os_error_to_pipeline_error(error, executable="node") from error
    if result.returncode != 0:
        raise PipelineError(
            ErrorCode.RENDER_FAILED,
            "Render process failed",
            {"returncode": result.returncode, "stderr": result.stderr.strip()},
        )
    codec = _probe_video_codec(output_video_path)
    if codec != "h264":
        raise PipelineError(
            ErrorCode.ARTIFACT_VALIDATION_FAILED,
            "Prototype output contract requires H.264 codec",
            {"codec": codec},
        )
    if include_evidence:
        return output_video_path, {
            "effective_encoder": str(nvenc.get("encoder") or "remotion-h264"),
            "nvenc_reason": nvenc.get("reason"),
        }
    return output_video_path


def _has_audio_stream(path: Path) -> bool:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    return result.returncode == 0 and "audio" in str(result.stdout or "").lower()


def mux_source_audio(rendered_video: Path, source_video_path: str | Path | None) -> Path:
    """Keep the source track in the black subtitle render.

    The Subtítulos contract renders a black background with the translated
    cues, so Remotion produces a video-only artifact. The operator still
    expects the uploaded narration in the downloadable MP4; when the source
    carries an audio stream we mux it back without re-encoding the video.
    """
    source = Path(source_video_path) if source_video_path else None
    if not rendered_video.is_file() or source is None or not source.is_file():
        return rendered_video
    if not _has_audio_stream(source):
        return rendered_video

    output = rendered_video.with_name(f"{rendered_video.stem}.with-audio{rendered_video.suffix}")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(rendered_video),
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError as error:
        raise map_os_error_to_pipeline_error(error, executable="ffmpeg") from error
    if result.returncode != 0:
        raise PipelineError(
            ErrorCode.RENDER_FAILED,
            "Could not mux the source audio into the subtitles video",
            {"returncode": result.returncode, "stderr": result.stderr.strip()},
        )
    output.replace(rendered_video)
    return rendered_video


def render_black_subtitles_video(session_dir: Path, source_video_path: str | Path, segments: list[dict[str, Any]]) -> Path:
    output_path = session_dir / "video-final.mp4"
    render_props_path = session_dir / "render-props.json"
    subtitles = build_render_subtitles_payload(segments)
    # The contract for the Subtítulos 2 remote service is a pure black
    # background with the translated subtitles overlaid. The React
    # composition skips the <OffthreadVideo> layer when
    # `source_static_path` is empty, so we explicitly set
    # `black_background_only: true` to tell the Node.js render script
    # NOT to fall back to the uploaded source.mp4 in the session dir.
    write_json(
        render_props_path,
        {
            "width": 1920,
            "height": 1080,
            "fps": 30,
            "background": "#000000",
            "black_background_only": True,
            "subtitles": subtitles,
        },
    )
    run_render(render_props_path=render_props_path, output_video_path=output_path)
    return mux_source_audio(output_path, source_video_path)
