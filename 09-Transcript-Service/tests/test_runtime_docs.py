from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_backend_runtime_docs_and_env_examples_cover_local_dependencies():
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "TRANSCRIPT_SERVICE_FFMPEG_BINARY" in env_example
    assert "TRANSCRIPT_SERVICE_YT_DLP_BINARY" in env_example
    assert "TRANSCRIPT_SERVICE_YT_DLP_COOKIES_PATH" in env_example
    assert "TRANSCRIPT_SERVICE_YT_DLP_JS_RUNTIME" in env_example
    assert "TRANSCRIPT_SERVICE_WHISPER_MODEL=large-v3" in env_example
    assert "TRANSCRIPT_SERVICE_WHISPER_MODEL_PATH" in env_example
    assert "TRANSCRIPT_SERVICE_CUDA_DLL_DIRS" in env_example
    assert "TRANSCRIPT_SERVICE_CUDA_DLL_DIRS" in readme
    assert "audio/audio-16khz.wav" in readme
    assert "scripts/check-preflight.ps1" in readme
    assert "secrets/youtube-cookies.txt" in readme
    assert "Cloudflare Tunnel" in readme


def test_runtime_scripts_and_service_notes_exist_with_check_commands():
    expected_scripts = ["run-dev.ps1", "install-nssm.ps1", "check-preflight.ps1"]
    for script in expected_scripts:
        script_text = (ROOT / "scripts" / script).read_text(encoding="utf-8")
        assert "TRANSCRIPT_SERVICE_API_KEY" in script_text

    services_readme = ROOT.parents[0] / "local" / "services" / "README.md"
    service_notes = services_readme.read_text(encoding="utf-8")
    assert "transcript-service-radar" in service_notes
    assert "/api/radar/health" in service_notes


def test_run_service_prepends_configured_cuda_dll_dirs_without_requiring_them():
    run_service = (ROOT / "scripts" / "run-service.ps1").read_text(encoding="utf-8")

    assert "TRANSCRIPT_SERVICE_CUDA_DLL_DIRS" in run_service
    assert "-split ';'" in run_service
    assert "Test-Path -LiteralPath $dir -PathType Container" in run_service
    assert "Write-Warning" in run_service
    assert "$pathEntries += $venvScripts" in run_service


def test_preflight_docs_distinguish_public_liveness_from_authenticated_health():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    check_preflight = (ROOT / "scripts" / "check-preflight.ps1").read_text(encoding="utf-8")

    assert "/api/radar/live" in readme
    assert "preflight `/api/radar/health` requires `x-api-key`" in readme
    assert '"x-api-key"' in check_preflight
    assert "$env:TRANSCRIPT_SERVICE_API_KEY" in check_preflight


def test_radar_runtime_defaults_use_8765_and_tunnel_docs_are_placeholders_only():
    env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    run_dev = (ROOT / "scripts" / "run-dev.ps1").read_text(encoding="utf-8")
    install_nssm = (ROOT / "scripts" / "install-nssm.ps1").read_text(encoding="utf-8")

    combined = "\n".join([env_example, readme, run_dev, install_nssm])
    assert "--port 8765" in run_dev
    assert "--port 8765" in install_nssm
    assert "http://127.0.0.1:8765" in combined
    assert "8091" not in combined
    assert "<your-tunnel-hostname>" in readme
    assert "<your-cloudflare-tunnel-token>" in env_example


def test_service_local_gitignore_protects_runtime_state_and_generated_caches():
    ignore_text = (ROOT / ".gitignore").read_text(encoding="utf-8")

    assert "runtime/" in ignore_text
    assert "runtime-logs/" in ignore_text
    assert "secrets/" in ignore_text
    assert "__pycache__/" in ignore_text
    assert "*.py[cod]" in ignore_text
