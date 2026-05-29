from __future__ import annotations

import json

from app.mention_diagnostics import build_report_payload, find_stale_mention_artifacts, main
from app.models import TranscriptSegment
from app.store import JobStore


def test_find_stale_mention_artifacts_reports_zero_count_jobs_that_match_current_catalog(tmp_path):
    store = JobStore(tmp_path)
    stale = store.create_job(url="https://video.example/stale", countries=["ecuador"], extra_keywords=[])
    store.update_metadata(stale.job_id, detected_language=None, variants_used={"Ecuador": ["Ecuador"]})
    store.save_transcript(
        stale.job_id,
        [TranscriptSegment(id="seg-1", start_ms=5000, end_ms=9000, text="Pacho gana el duelo aéreo.")],
        detected_language=None,
    )
    store.save_mentions(stale.job_id, [], detected_language=None)
    store.save_summary(stale.job_id, {"items": []})
    store.mark_succeeded(stale.job_id)

    findings = find_stale_mention_artifacts(tmp_path)

    assert [finding.job_id for finding in findings] == [stale.job_id]
    assert findings[0].stored_mention_count == 0
    assert findings[0].stored_mentions_count == 0
    assert findings[0].stored_summary_count == 0
    assert findings[0].rerun_mention_count == 1
    assert findings[0].rerun_matches == [
        {
            "keyword": "pacho",
            "canonical": "Willian Pacho",
            "country": "ecuador",
            "segment_id": "seg-1",
            "start_ms": 5000,
            "end_ms": 9000,
        }
    ]
    assert findings[0].variants_used == {"Ecuador": ["Ecuador"]}
    assert json.loads((tmp_path / "jobs" / stale.job_id / "mentions.json").read_text(encoding="utf-8"))["matches"] == []
    assert store.get_job(stale.job_id).mention_count == 0


def test_build_report_payload_keeps_consistent_jobs_out_of_findings(tmp_path):
    store = JobStore(tmp_path)
    consistent = store.create_job(url="https://video.example/consistent", countries=["argentina"], extra_keywords=[])
    segments = [TranscriptSegment(id="seg-1", start_ms=1000, end_ms=3000, text="Sin términos relevantes.")]
    store.save_transcript(consistent.job_id, segments, detected_language="es")
    store.save_mentions(consistent.job_id, [], detected_language="es")
    store.save_summary(consistent.job_id, {"detected_language": "es", "items": []})
    store.mark_succeeded(consistent.job_id)

    payload = build_report_payload(tmp_path)

    assert payload == {
        "runtime_dir": str(tmp_path),
        "checked_jobs": 1,
        "stale_jobs": 0,
        "findings": [],
    }


def test_diagnostic_cli_prints_json_report_without_loading_env_secrets(tmp_path, capsys):
    exit_code = main(["--runtime-dir", str(tmp_path)])

    assert exit_code == 0
    assert json.loads(capsys.readouterr().out) == {
        "runtime_dir": str(tmp_path),
        "checked_jobs": 0,
        "stale_jobs": 0,
        "findings": [],
    }
