from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .mention_engine import find_mentions
from .models import JobRecord, MentionArtifact, MentionMatch, TranscriptArtifact


@dataclass(frozen=True)
class MentionArtifactFinding:
    job_id: str
    stored_mention_count: int
    stored_mentions_count: int
    stored_summary_count: int
    rerun_mention_count: int
    selected_countries: list[str]
    detected_language: str | None
    variants_used: dict[str, list[str]]
    rerun_matches: list[dict[str, Any]]

    def to_payload(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "stored_mention_count": self.stored_mention_count,
            "stored_mentions_count": self.stored_mentions_count,
            "stored_summary_count": self.stored_summary_count,
            "rerun_mention_count": self.rerun_mention_count,
            "selected_countries": self.selected_countries,
            "detected_language": self.detected_language,
            "variants_used": self.variants_used,
            "rerun_matches": self.rerun_matches,
        }


def find_stale_mention_artifacts(runtime_dir: Path | str) -> list[MentionArtifactFinding]:
    jobs_dir = Path(runtime_dir) / "jobs"
    index_path = jobs_dir / "index.json"
    if not index_path.exists():
        return []

    findings: list[MentionArtifactFinding] = []
    for item in _read_json(index_path).get("items", []):
        job_id = item.get("job_id")
        if not isinstance(job_id, str):
            continue
        job_path = jobs_dir / job_id / "job.json"
        transcript_path = jobs_dir / job_id / "transcript.json"
        if not job_path.exists() or not transcript_path.exists():
            continue

        record = JobRecord(**_read_json(job_path))
        transcript = TranscriptArtifact(**_read_json(transcript_path))
        detected_language = transcript.detected_language or record.detected_language
        rerun_matches = find_mentions(
            transcript.segments,
            target=record.target,
            countries=record.selected_countries,
            detected_language=detected_language,
            extra_keywords=record.extra_keywords,
        )
        stored_mentions_count = _stored_mentions_count(jobs_dir / job_id / "mentions.json")
        stored_summary_count = _stored_summary_count(jobs_dir / job_id / "summary.json")
        if record.mention_count == stored_mentions_count == 0 and len(rerun_matches) > 0:
            findings.append(
                MentionArtifactFinding(
                    job_id=record.job_id,
                    stored_mention_count=record.mention_count,
                    stored_mentions_count=stored_mentions_count,
                    stored_summary_count=stored_summary_count,
                    rerun_mention_count=len(rerun_matches),
                    selected_countries=record.selected_countries,
                    detected_language=detected_language,
                    variants_used=record.variants_used,
                    rerun_matches=[_match_payload(match) for match in rerun_matches],
                )
            )
    return findings


def build_report_payload(runtime_dir: Path | str) -> dict[str, Any]:
    runtime_path = Path(runtime_dir)
    findings = find_stale_mention_artifacts(runtime_path)
    return {
        "runtime_dir": str(runtime_path),
        "checked_jobs": _checked_job_count(runtime_path),
        "stale_jobs": len(findings),
        "findings": [finding.to_payload() for finding in findings],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Report stale Transcript mention artifacts without modifying runtime files.")
    parser.add_argument("--runtime-dir", default="runtime", help="Transcript runtime directory containing jobs/index.json")
    args = parser.parse_args(argv)
    print(json.dumps(build_report_payload(args.runtime_dir), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def _checked_job_count(runtime_dir: Path) -> int:
    index_path = runtime_dir / "jobs" / "index.json"
    if not index_path.exists():
        return 0
    return sum(1 for item in _read_json(index_path).get("items", []) if isinstance(item.get("job_id"), str))


def _stored_mentions_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(MentionArtifact(**_read_json(path)).matches)


def _stored_summary_count(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(int(item.get("count", 0)) for item in _read_json(path).get("items", []) if isinstance(item, dict))


def _match_payload(match: MentionMatch) -> dict[str, Any]:
    return {
        "keyword": match.keyword,
        "canonical": match.canonical,
        "country": match.country,
        "segment_id": match.segment_id,
        "start_ms": match.start_ms,
        "end_ms": match.end_ms,
    }


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(main())
