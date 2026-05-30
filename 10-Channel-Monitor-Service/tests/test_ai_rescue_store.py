from __future__ import annotations

import sqlite3

from app.store import ChannelRecord, MonitorStore, VideoRecord
from app.workers import EnqueueWorker


class FakeRadarSubmitter:
    def __init__(self):
        self.calls: list[tuple[str, list[str]]] = []

    def submit_job(self, url: str, *, countries: list[str]):
        from app.radar_client import RadarJobResult

        self.calls.append((url, countries))
        return RadarJobResult(job_id="job-ai-rescue", status="queued")


def test_ai_rescue_migration_adds_isolated_tables_and_preserves_rejected_rows(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    store = MonitorStore(db_path)
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="trash-1", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="trash-1", source_country="colombia", reason="no_title_match")

    with sqlite3.connect(db_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            )
        }
        rejected_count = connection.execute("select count(*) from rejected_videos").fetchone()[0]

    assert {
        "ai_rescue_queue",
        "ai_rescue_candidates",
        "ai_rescue_evidence",
        "ai_rescue_decisions",
        "ai_rescue_rejections",
    }.issubset(tables)
    assert rejected_count == 1


def test_ai_rescue_queue_enqueues_rejected_videos_fifo_without_duplicates(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    for video_id, title in [("old", "Colombia local"), ("new", "Otra noticia")]:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=title, lifecycle="ignored_seen"))
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="no_valid_target_match")

    first = store.enqueue_ai_rescue_rejected_video(video_id="old", now="2026-05-22T10:00:00Z")
    duplicate = store.enqueue_ai_rescue_rejected_video(video_id="old", now="2026-05-22T10:05:00Z")
    second = store.enqueue_ai_rescue_rejected_video(video_id="new", now="2026-05-22T10:10:00Z")
    queue = store.list_ai_rescue_queue(limit=10)
    snapshot = store.ai_rescue_queue_snapshot(now="2026-05-22T10:11:00Z", upcoming_limit=5)

    assert duplicate.id == first.id
    assert [(item.video_id, item.status, item.attempt_count) for item in queue] == [
        ("old", "waiting", 0),
        ("new", "waiting", 0),
    ]
    assert second.id != first.id
    assert snapshot["current"] is None
    assert [item.video_id for item in snapshot["upcoming"]] == ["old", "new"]
    assert snapshot["counts"] == {"waiting": 2, "processing": 0, "retry": 0}


def test_ai_rescue_queue_claim_is_single_owner_and_skips_processing_items(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="only-once", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="only-once", source_country="colombia", reason="no_valid_target_match")
    store.enqueue_ai_rescue_rejected_video(video_id="only-once", now="2026-05-22T10:00:00Z")

    first = store.claim_next_ai_rescue_queue_item(now="2026-05-22T10:01:00Z")
    second = store.claim_next_ai_rescue_queue_item(now="2026-05-22T10:01:00Z")

    assert first is not None
    assert first.video_id == "only-once"
    assert first.status == "processing"
    assert second is None


def test_ai_rescue_reaper_returns_stale_processing_items_to_retry(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="stale", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="stale", source_country="colombia", reason="no_valid_target_match")
    store.enqueue_ai_rescue_rejected_video(video_id="stale", now="2026-05-22T10:00:00Z")
    claimed = store.claim_next_ai_rescue_queue_item(now="2026-05-22T10:00:00Z")

    reaped = store.reap_stale_ai_rescue_processing(now="2026-05-22T10:31:00Z", stale_after_seconds=1800)
    item = store.get_ai_rescue_queue_item(claimed.id)

    assert reaped == 1
    assert item.status == "retry"
    assert item.next_attempt_at == "2026-05-22T10:31:00Z"
    assert item.last_error == "stale-processing"


def test_ai_rescue_queue_reference_is_reported_by_detected_at_retention_plan(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="queued-trash",
            channel_id=channel.id,
            title="Solo Colombia",
            lifecycle="ignored_seen",
            detected_at="2026-05-20T00:00:00Z",
        )
    )
    store.upsert_rejected_video(video_id="queued-trash", source_country="colombia", reason="no_valid_target_match")
    store.enqueue_ai_rescue_rejected_video(video_id="queued-trash", now="2026-05-22T10:00:00Z")
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("delete from rejected_videos where video_id = 'queued-trash'")

    report = store.build_retention_dry_run_report(cutoff="2026-05-25T00:00:00Z")

    assert report.items[0].video_id == "queued-trash"
    assert report.items[0].planned_deletions["ai_rescue_queue"] == 1
    assert store.get_video("queued-trash") is not None


def test_ai_rescue_candidates_evidence_rejections_and_human_decisions_are_recorded(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="trash-1", channel_id=channel.id, title="Elogio a Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="trash-1", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-1", now="2026-05-22T10:00:00Z")

    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="ecuador",
        score=86,
        summary_es="Hablan muy bien de Ecuador.",
        angle_es="Ecuador recibe elogios deportivos.",
        risk="low",
        risks_json='["none"]',
        evidence=[
            {
                "start_ms": 1000,
                "end_ms": 12000,
                "text": "Ecuador played beautifully",
                "translation_es": "Ecuador jugó hermoso",
                "explanation_es": "Elogio futbolístico explícito.",
            },
            {
                "start_ms": 13000,
                "end_ms": 23000,
                "text": "They deserve praise",
                "translation_es": "Merecen elogios",
                "explanation_es": "Refuerza el tono positivo.",
            },
        ],
        raw_response_json='{"candidates":[]}',
    )
    rejection = store.store_ai_rescue_rejection(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="mexico",
        source="ai",
        reason="weak-evidence",
        details_json='{"explanation_es":"Mención débil"}',
    )
    human = store.mark_ai_rescue_candidate_rejected(
        candidate.id,
        reviewer="tester",
        reason="not enough context",
        decided_at="2026-05-22T10:30:00Z",
    )

    detail = store.get_ai_rescue_candidate(candidate.id)
    visible = store.list_ai_rescue_candidates()
    rejected = store.list_ai_rescue_rejections()

    assert detail is not None
    assert detail.status == "rejected"
    assert detail.evidence[0].translation_es == "Ecuador jugó hermoso"
    assert visible == []
    assert rejection.reason == "weak-evidence"
    assert human.decision == "rejected"
    assert [(entry.source, entry.reason) for entry in rejected] == [("ai", "weak-evidence"), ("human", "not enough context")]


def test_ai_rescue_candidate_and_rejection_storage_are_idempotent_per_queue_target(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="trash-2", channel_id=channel.id, title="Elogio a Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="trash-2", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-2", now="2026-05-22T10:00:00Z")

    first = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-2",
        target_country="ecuador",
        score=80,
        summary_es="Antes",
        angle_es="Antes",
        risk="low",
        evidence=[],
        raw_response_json="{}",
    )
    second = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-2",
        target_country="ecuador",
        score=90,
        summary_es="Despues",
        angle_es="Despues",
        risk="low",
        evidence=[],
        raw_response_json="{}",
    )
    rejection = store.store_ai_rescue_rejection(
        queue_id=queue_item.id,
        video_id="trash-2",
        target_country="mexico",
        source="ai",
        reason="weak-evidence",
    )
    duplicate_rejection = store.store_ai_rescue_rejection(
        queue_id=queue_item.id,
        video_id="trash-2",
        target_country="mexico",
        source="ai",
        reason="weak-evidence",
    )

    candidates = store.list_ai_rescue_candidates()
    rejections = store.list_ai_rescue_rejections()
    assert second.id == first.id
    assert [(candidate.target_country, candidate.score, candidate.summary_es) for candidate in candidates] == [
        ("ecuador", 90, "Despues")
    ]
    assert duplicate_rejection.id == rejection.id
    assert [(item.target_country, item.reason) for item in rejections] == [("mexico", "weak-evidence")]


def test_ai_rescue_candidate_dismissal_filters_only_candidate_context_without_changing_decision_state(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="trash-dismiss", channel_id=channel.id, title="Elogio a Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="trash-dismiss", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-dismiss", now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-dismiss",
        target_country="ecuador",
        score=85,
        summary_es="Ecuador destacado.",
        angle_es="Elogio deportivo.",
        risk="low",
        evidence=[],
        raw_response_json="{}",
    )

    store.upsert_card_context_dismissal(
        surface="ai-rescue-candidate",
        target_context="ecuador",
        video_id="trash-dismiss",
        candidate_id=candidate.id,
        dismissed_at="2026-05-22T10:30:00Z",
    )

    assert store.list_ai_rescue_candidates(now="2026-05-22T10:31:00Z") == []
    assert store.get_ai_rescue_candidate(candidate.id).status == "candidate"
    assert store.list_target_matches(video_id="trash-dismiss") == []
    assert store.get_video("trash-dismiss") is not None


def test_ai_rescue_human_approval_promotes_candidate_without_widening_targets(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="trash-1", channel_id=channel.id, title="Elogio a Ecuador", lifecycle="enqueue_pending"))
    store.upsert_rejected_video(video_id="trash-1", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="trash-1", now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="trash-1",
        target_country="ecuador",
        score=91,
        summary_es="Ecuador queda recomendado.",
        angle_es="Elogio futbolístico a Ecuador.",
        risk="low",
        risks_json="[]",
        evidence=[],
        raw_response_json="{}",
    )

    decision = store.mark_ai_rescue_candidate_approved(
        candidate.id,
        reviewer="tester",
        decided_at="2026-05-22T10:40:00Z",
    )
    promoted = store.promote_ai_rescue_candidate(candidate.id, allowed_target_countries=["ecuador", "mexico"])

    matches = store.list_target_matches(video_id="trash-1")
    assert decision.decision == "approved"
    assert promoted.status == "aprobado"
    assert promoted.approval_source == "ai_rescue"
    assert [(match.target_country, match.status, match.approval_source) for match in matches] == [
        ("ecuador", "aprobado", "ai_rescue")
    ]
    assert store.get_ai_rescue_candidate(candidate.id).status == "approved"


def test_ai_rescue_approval_assigns_algorithm_priority_tier_for_selected_country(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="colombia",
            label="Priority source",
            source_url=None,
            youtube_channel_id="UCPriority",
            algorithm_priority_rank=4,
        )
    )
    store.upsert_video(VideoRecord(video_id="ai-priority", channel_id=channel.id, title="Elogio a Ecuador", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="ai-priority", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="ai-priority", now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="ai-priority",
        target_country="ecuador",
        score=94,
        summary_es="Ecuador queda recomendado.",
        angle_es="Elogio futbolístico a Ecuador.",
        risk="low",
        risks_json="[]",
        evidence=[],
        raw_response_json="{}",
    )

    promoted = store.promote_ai_rescue_candidate(candidate.id, allowed_target_countries=["ecuador"])
    video = store.get_video("ai-priority")

    assert promoted.target_country == "ecuador"
    assert promoted.approval_source == "ai_rescue"
    assert promoted.queue_priority_tier == "ecuador:algorithm_priority"
    assert promoted.queue_priority_rank == 1
    assert video.important_mode is None
    assert video.queue_priority_tier is None


def test_ai_rescue_approval_assigns_normal_tier_and_keeps_source_country_exclusion(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Normal source", source_url=None, youtube_channel_id="UCNormal")
    )
    store.upsert_video(VideoRecord(video_id="ai-normal", channel_id=channel.id, title="Elogio a México", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="ai-normal", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="ai-normal", now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="ai-normal",
        target_country="mexico",
        score=88,
        summary_es="México queda recomendado.",
        angle_es="Elogio futbolístico a México.",
        risk="low",
        risks_json="[]",
        evidence=[],
        raw_response_json="{}",
    )

    promoted = store.promote_ai_rescue_candidate(candidate.id, allowed_target_countries=["mexico"])

    assert promoted.queue_priority_tier == "mexico:normal"
    assert promoted.queue_priority_rank == 12

    same_source = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="ai-normal",
        target_country="colombia",
        score=91,
        summary_es="Colombia queda recomendado.",
        angle_es="Elogio doméstico.",
        risk="low",
        risks_json="[]",
        evidence=[],
        raw_response_json="{}",
    )
    try:
        store.promote_ai_rescue_candidate(same_source.id, allowed_target_countries=["colombia"])
    except ValueError as exc:
        assert str(exc) == "target_country_matches_source"
    else:
        raise AssertionError("source-country AI approval should be rejected")


def test_ai_rescue_approval_moves_rejected_video_to_enqueue_pending_for_enqueue_worker(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="rescued-trash",
            channel_id=channel.id,
            title="Elogio a Ecuador",
            url="https://youtu.be/rescued-trash",
            lifecycle="ignored_seen",
            matched=False,
        )
    )
    store.upsert_rejected_video(video_id="rescued-trash", source_country="colombia", reason="no_valid_target_match")
    queue_item = store.enqueue_ai_rescue_rejected_video(video_id="rescued-trash", now="2026-05-22T10:00:00Z")
    candidate = store.store_ai_rescue_candidate(
        queue_id=queue_item.id,
        video_id="rescued-trash",
        target_country="ecuador",
        score=91,
        summary_es="Ecuador queda recomendado.",
        angle_es="Elogio futbolístico a Ecuador.",
        risk="low",
        risks_json="[]",
        evidence=[],
        raw_response_json="{}",
    )
    radar = FakeRadarSubmitter()

    store.promote_ai_rescue_candidate(candidate.id, allowed_target_countries=["ecuador"])
    enqueued = EnqueueWorker(store=store, radar=radar, now=lambda: "2026-05-22T10:45:00Z").enqueue_due()

    video = store.get_video("rescued-trash")
    assert video is not None
    assert video.matched is True
    assert [item.video_id for item in enqueued] == ["rescued-trash"]
    assert radar.calls == [("https://youtu.be/rescued-trash", ["ecuador"])]
    assert store.get_video("rescued-trash").lifecycle == "enqueued"
    assert store.list_target_matches(video_id="rescued-trash")[0].status == "transcribiendo"
