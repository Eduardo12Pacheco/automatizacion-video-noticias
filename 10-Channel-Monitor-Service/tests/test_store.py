from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.settings import ImportantRule
from app.store import ChannelRecord, MonitorStore, TargetMatchRecord, VideoRecord


def test_store_migrates_required_monitor_tables(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"

    store = MonitorStore(db_path)
    store.migrate()

    with sqlite3.connect(db_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            )
        }

    assert tables == {
        "channels",
        "videos",
        "enqueue_attempts",
        "video_target_matches",
        "rejected_videos",
        "subscriptions",
        "boundary_websub_events",
        "cleanup_runs",
        "classification_runs",
        "ai_rescue_queue",
        "ai_rescue_candidates",
        "ai_rescue_evidence",
        "ai_rescue_decisions",
        "ai_rescue_rejections",
        "important_summary_mentions",
        "card_context_dismissals",
    }


def test_store_migrates_classification_columns_additively_and_preserves_rows(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            create table channels (
                id integer primary key autoincrement,
                country text not null,
                label text not null,
                source_url text,
                youtube_channel_id text not null unique,
                uploads_playlist_id text,
                enabled integer not null default 1,
                last_seen_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table videos (
                video_id text primary key,
                channel_id integer references channels(id),
                title text,
                url text,
                published_at text,
                live_status text,
                lifecycle text not null,
                matched integer,
                match_reason text,
                evaluated_at text,
                next_poll_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table video_target_matches (
                id integer primary key autoincrement,
                video_id text not null references videos(video_id),
                target_country text not null,
                status text not null,
                title_match_reason text,
                radar_job_id text,
                mention_counts_json text,
                last_error text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp,
                unique(video_id, target_country)
            );
            create table rejected_videos (
                id integer primary key autoincrement,
                video_id text not null references videos(video_id) unique,
                source_country text,
                reason text not null,
                match_reason_json text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            insert into videos(video_id, title, lifecycle, matched)
            values ('legacy-video', 'Legacy title', 'ignored_seen', 0);
            insert into video_target_matches(video_id, target_country, status, radar_job_id)
            values ('legacy-video', 'ecuador', 'transcribiendo', 'job-legacy');
            insert into rejected_videos(video_id, source_country, reason)
            values ('legacy-video', 'colombia', 'legacy_reason');
            """
        )

    store = MonitorStore(db_path)
    store.migrate()

    assert store.get_video("legacy-video").title == "Legacy title"
    with sqlite3.connect(db_path) as connection:
        video_columns = {row[1] for row in connection.execute("pragma table_info(videos)")}
        match_columns = {row[1] for row in connection.execute("pragma table_info(video_target_matches)")}
        rejected_columns = {row[1] for row in connection.execute("pragma table_info(rejected_videos)")}
        protected = connection.execute(
            "select status, radar_job_id from video_target_matches where video_id = 'legacy-video'"
        ).fetchone()

    assert {"classification_version", "classified_at", "classification_status", "classification_reason", "classification_run_id"}.issubset(video_columns)
    assert {"classification_version", "classified_at", "classification_run_id", "approval_source"}.issubset(match_columns)
    assert {"classification_version", "classified_at", "classification_run_id"}.issubset(rejected_columns)
    assert protected == ("transcribiendo", "job-legacy")


def test_store_migrates_important_audit_columns_additively_and_idempotently(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            create table channels (
                id integer primary key autoincrement,
                country text not null,
                label text not null,
                source_url text,
                youtube_channel_id text not null unique,
                uploads_playlist_id text,
                enabled integer not null default 1,
                important integer not null default 0,
                priority_tier text,
                algorithm_priority_rank integer,
                last_seen_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table videos (
                video_id text primary key,
                channel_id integer references channels(id),
                title text,
                url text,
                published_at text,
                live_status text,
                lifecycle text not null,
                matched integer,
                match_reason text,
                evaluated_at text,
                next_poll_at text,
                classification_version text,
                classified_at text,
                classification_status text,
                classification_reason text,
                classification_run_id integer,
                detected_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table enqueue_attempts (
                id integer primary key autoincrement,
                video_id text not null references videos(video_id),
                status text not null,
                radar_job_id text,
                attempt_count integer not null default 0,
                next_attempt_at text,
                last_error text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table video_target_matches (
                id integer primary key autoincrement,
                video_id text not null references videos(video_id),
                target_country text not null,
                status text not null,
                title_match_reason text,
                radar_job_id text,
                mention_counts_json text,
                last_error text,
                classification_version text,
                classified_at text,
                classification_run_id integer,
                approval_source text not null default 'title_classifier',
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp,
                unique(video_id, target_country)
            );
            insert into channels(country, label, youtube_channel_id, important, algorithm_priority_rank)
            values ('argentina', 'Legacy', 'UCLegacy', 0, 9);
            insert into videos(video_id, channel_id, title, lifecycle, matched)
            values ('legacy-video', 1, 'Legacy title', 'enqueue_pending', 1);
            insert into video_target_matches(video_id, target_country, status)
            values ('legacy-video', 'ecuador', 'aprobado');
            """
        )

    store = MonitorStore(db_path)
    store.migrate()
    store.migrate()

    with sqlite3.connect(db_path) as connection:
        channel_columns = {row[1] for row in connection.execute("pragma table_info(channels)")}
        video_columns = {row[1] for row in connection.execute("pragma table_info(videos)")}
        target_columns = {row[1] for row in connection.execute("pragma table_info(video_target_matches)")}
        attempt_columns = {row[1] for row in connection.execute("pragma table_info(enqueue_attempts)")}
        row_count = connection.execute("select count(*) from videos where video_id = 'legacy-video'").fetchone()[0]

    assert {"important_mode", "important_rules_json"}.issubset(channel_columns)
    assert {"important_mode", "important_rule_json", "queue_priority_tier", "queue_priority_rank"}.issubset(video_columns)
    assert {"queue_priority_tier", "queue_priority_rank"}.issubset(target_columns)
    assert {"queue_priority_tier", "queue_priority_rank"}.issubset(attempt_columns)
    assert row_count == 1


def test_store_migration_preserves_existing_video_rows_when_adding_target_tables(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            create table channels (
                id integer primary key autoincrement,
                country text not null,
                label text not null,
                source_url text,
                youtube_channel_id text not null unique,
                uploads_playlist_id text,
                enabled integer not null default 1,
                last_seen_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            create table videos (
                video_id text primary key,
                channel_id integer references channels(id),
                title text,
                url text,
                published_at text,
                live_status text,
                lifecycle text not null,
                matched integer,
                match_reason text,
                evaluated_at text,
                next_poll_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            insert into videos(video_id, title, lifecycle, matched)
            values ('legacy-video', 'Legacy title', 'ignored_seen', 0);
            """
        )

    store = MonitorStore(db_path)
    store.migrate()

    assert store.get_video("legacy-video").title == "Legacy title"
    with sqlite3.connect(db_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            )
        }
    assert "video_target_matches" in tables
    assert "rejected_videos" in tables


def test_store_upserts_channels_by_stable_youtube_channel_id(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    first = store.upsert_channel(
        ChannelRecord(
            country="fr",
            label="L'Équipe",
            source_url="https://www.youtube.com/@lequipe",
            youtube_channel_id="UClequipeStable",
            uploads_playlist_id="UUlequipeStable",
            enabled=True,
        )
    )
    second = store.upsert_channel(
        ChannelRecord(
            country="fr",
            label="L'Équipe updated",
            source_url="https://www.youtube.com/@lequipe",
            youtube_channel_id="UClequipeStable",
            uploads_playlist_id="UUlequipeStable",
            enabled=False,
        )
    )

    channels = store.list_channels()

    assert second.id == first.id
    assert len(channels) == 1
    assert channels[0].label == "L'Équipe updated"
    assert channels[0].enabled is False


def test_store_persists_important_channel_metadata_by_stable_youtube_channel_id(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    first = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url="https://www.youtube.com/@NSportsGo",
            youtube_channel_id="UCImportantStable",
            uploads_playlist_id="UUImportantStable",
            enabled=True,
            important=True,
            priority_tier="importantes",
            algorithm_priority_rank=1,
        )
    )
    second = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports updated",
            source_url="https://www.youtube.com/@NSportsGo",
            youtube_channel_id="UCImportantStable",
            uploads_playlist_id="UUImportantStable",
            enabled=True,
            important=False,
            priority_tier=None,
            algorithm_priority_rank=11,
        )
    )

    channels = store.list_channels()

    assert second.id == first.id
    assert len(channels) == 1
    assert channels[0].important is False
    assert channels[0].priority_tier is None
    assert channels[0].algorithm_priority_rank == 11


def test_store_persists_important_mode_and_program_rules_in_channel_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    store.upsert_channel(
        ChannelRecord(
            country="peru",
            label="Mr Peet",
            source_url="https://www.youtube.com/@MrPeet",
            youtube_channel_id="UCMrPeet",
            important=False,
            important_mode="program_rules",
            important_rules=[{"content_types": ["completed"], "op": "starts_with", "value": "MADRUGOL CON MR PEET"}],
            algorithm_priority_rank=7,
        )
    )
    reloaded = MonitorStore(store.db_path)
    reloaded.migrate()

    channel = reloaded.find_channel_by_youtube_id("UCMrPeet")

    assert channel.important is False
    assert channel.important_mode == "program_rules"
    assert channel.important_rules == [
        {"content_types": ["completed"], "op": "starts_with", "value": "MADRUGOL CON MR PEET"}
    ]
    assert channel.algorithm_priority_rank == 7


def test_store_migrates_channel_importance_columns_additively_and_preserves_rows(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    with sqlite3.connect(db_path) as connection:
        connection.executescript(
            """
            create table channels (
                id integer primary key autoincrement,
                country text not null,
                label text not null,
                source_url text,
                youtube_channel_id text not null unique,
                uploads_playlist_id text,
                enabled integer not null default 1,
                last_seen_at text,
                created_at text not null default current_timestamp,
                updated_at text not null default current_timestamp
            );
            insert into channels(country, label, youtube_channel_id, enabled)
            values ('argentina', 'Legacy Important', 'UCLegacyImportant', 1);
            """
        )

    store = MonitorStore(db_path)
    store.migrate()
    channel = store.find_channel_by_youtube_id("UCLegacyImportant")

    assert channel is not None
    assert channel.label == "Legacy Important"
    assert channel.important is False
    assert channel.priority_tier is None
    assert channel.algorithm_priority_rank is None
    with sqlite3.connect(db_path) as connection:
        channel_columns = {row[1] for row in connection.execute("pragma table_info(channels)")}
    assert {"important", "priority_tier", "algorithm_priority_rank"}.issubset(channel_columns)


def test_list_target_cards_prioritizes_algorithm_channels_then_mentions_then_rank(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    mundo = store.upsert_channel(
        ChannelRecord(
            country="espana",
            label="Mundo Maldini",
            source_url=None,
            youtube_channel_id="UCMundo",
            algorithm_priority_rank=11,
        )
    )
    ariana = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="Ariana Isasi",
            source_url=None,
            youtube_channel_id="UCAriana",
            algorithm_priority_rank=32,
        )
    )
    normal = store.upsert_channel(
        ChannelRecord(country="colombia", label="Normal", source_url=None, youtube_channel_id="UCNormal")
    )

    for video_id, channel, published_at, mention_count in [
        ("normal-high", normal, "2026-05-22T12:00:00Z", 50),
        ("mundo-15", mundo, "2026-05-20T12:00:00Z", 15),
        ("ariana-20", ariana, "2026-05-19T12:00:00Z", 20),
    ]:
        store.upsert_video(
            VideoRecord(
                video_id=video_id,
                channel_id=channel.id,
                title="Ecuador",
                published_at=published_at,
                lifecycle="transcrito",
                matched=True,
            )
        )
        store.upsert_target_match(
            TargetMatchRecord(
                video_id=video_id,
                target_country="ecuador",
                status="transcrito",
                mention_counts_json=_mention_counts_json(mention_count),
            )
        )

    cards = store.list_target_cards(target_country="ecuador", limit=10)

    assert [card["video_id"] for card in cards] == ["ariana-20", "mundo-15", "normal-high"]


def _mention_counts_json(count: int) -> str:
    return json.dumps([{"label": "Ecuador", "count": count}], separators=(",", ":"))


def test_list_catchup_channels_returns_only_enabled_channels_with_upload_playlists(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    enabled_with_uploads = store.upsert_channel(
        ChannelRecord(
            country="colombia",
            label="Caracol Deportes",
            source_url=None,
            youtube_channel_id="UCCaracol",
            uploads_playlist_id="UUCaracol",
            enabled=True,
        )
    )
    store.upsert_channel(
        ChannelRecord(
            country="ecuador",
            label="No uploads",
            source_url=None,
            youtube_channel_id="UCEcuador",
            uploads_playlist_id=None,
            enabled=True,
        )
    )
    store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="Disabled uploads",
            source_url=None,
            youtube_channel_id="UCDisabled",
            uploads_playlist_id="UUDisabled",
            enabled=False,
        )
    )

    assert store.list_catchup_channels() == [enabled_with_uploads]


def test_catchup_preflight_reports_enabled_channels_missing_upload_playlists(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    store.upsert_channel(
        ChannelRecord(
            country="colombia",
            label="Missing uploads",
            source_url=None,
            youtube_channel_id="UCMissingUploads",
            uploads_playlist_id=None,
            enabled=True,
        )
    )
    store.upsert_channel(
        ChannelRecord(
            country="peru",
            label="Ready uploads",
            source_url=None,
            youtube_channel_id="UCReadyUploads",
            uploads_playlist_id="UUReadyUploads",
            enabled=True,
        )
    )

    assert store.catchup_preflight() == {
        "status": "degraded",
        "ready_channel_count": 1,
        "findings": [
            {
                "code": "catchup_upload_playlist_missing",
                "channel_id": 1,
                "youtube_channel_id": "UCMissingUploads",
                "label": "Missing uploads",
                "country": "colombia",
            }
        ],
    }


def test_store_preflight_reports_ready_after_migration(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    report = store.preflight()

    assert report["status"] == "ready"
    assert report["tables"] == [
        "channels",
        "videos",
        "enqueue_attempts",
        "video_target_matches",
        "rejected_videos",
        "subscriptions",
        "boundary_websub_events",
        "cleanup_runs",
        "classification_runs",
        "ai_rescue_queue",
        "ai_rescue_candidates",
        "ai_rescue_evidence",
        "ai_rescue_decisions",
        "ai_rescue_rejections",
        "important_summary_mentions",
        "card_context_dismissals",
    ]


def test_card_context_dismissals_migrate_and_upsert_by_context_without_deleting_source(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", important=True)
    )
    store.upsert_video(VideoRecord(video_id="shared", channel_id=channel.id, title="Ecuador y Colombia", lifecycle="enqueued", matched=True))
    store.upsert_target_match(TargetMatchRecord(video_id="shared", target_country="ecuador", status="aprobado"))
    store.upsert_target_match(TargetMatchRecord(video_id="shared", target_country="colombia", status="aprobado"))

    first = store.upsert_card_context_dismissal(
        surface="monitor-card",
        target_context="Ecuador",
        video_id="shared",
        dismissed_at="2026-05-28T12:00:00Z",
        dismissed_by="control-panel",
        reason="operator-dismissed",
    )
    second = store.upsert_card_context_dismissal(
        surface="monitor-card",
        target_context="ecuador",
        video_id="shared",
        dismissed_at="2026-05-28T12:05:00Z",
        dismissed_by="control-panel",
        reason="operator-dismissed-again",
    )

    with sqlite3.connect(store.db_path) as connection:
        rows = connection.execute("select surface, target_context, video_id, dismissed_at, reason from card_context_dismissals").fetchall()

    assert first["context_key"] == "monitor-card:ecuador:shared"
    assert second["context_key"] == "monitor-card:ecuador:shared"
    assert rows == [("monitor-card", "ecuador", "shared", "2026-05-28T12:05:00Z", "operator-dismissed-again")]
    assert store.get_video("shared") is not None
    assert [(match.target_country, match.status) for match in store.list_target_matches(video_id="shared")] == [
        ("ecuador", "aprobado"),
        ("colombia", "aprobado"),
    ]


def test_card_context_dismissals_filter_only_matching_radar_contexts_counts_and_summary(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", important=True)
    )
    store.upsert_video(
        VideoRecord(
            video_id="shared",
            channel_id=channel.id,
            title="Ecuador y Colombia",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
            detected_at="2026-05-28T10:00:00Z",
        )
    )
    store.upsert_target_match(TargetMatchRecord(video_id="shared", target_country="ecuador", status="aprobado"))
    store.upsert_target_match(TargetMatchRecord(video_id="shared", target_country="colombia", status="transcrito"))
    store.upsert_card_context_dismissal(
        surface="monitor-card",
        target_context="ecuador",
        video_id="shared",
        dismissed_at="2026-05-28T12:00:00Z",
    )

    assert store.list_target_cards(target_country="ecuador", now="2026-05-28T12:30:00Z") == []
    assert [card["video_id"] for card in store.list_target_cards(target_country="colombia", now="2026-05-28T12:30:00Z")] == ["shared"]
    assert [card["target_country"] for card in store.list_target_cards(now="2026-05-28T12:30:00Z")] == ["colombia"]
    assert [card["video_id"] for card in store.list_important_cards(now="2026-05-28T12:30:00Z")] == ["shared"]
    assert store.count_target_cards(target_country="ecuador", now="2026-05-28T12:30:00Z") == 0
    assert store.count_target_cards(target_country="colombia", now="2026-05-28T12:30:00Z") == 1
    assert store.count_target_cards(now="2026-05-28T12:30:00Z") == 1
    assert store.count_important_cards(now="2026-05-28T12:30:00Z") == 1
    counts = store.target_status_counts(now="2026-05-28T12:30:00Z")
    assert counts["ecuador"]["aprobado"] == 0
    assert counts["colombia"]["transcrito"] == 1

    store.upsert_card_context_dismissal(
        surface="monitor-card",
        target_context="important",
        video_id="shared",
        dismissed_at="2026-05-28T12:40:00Z",
    )
    assert store.list_important_cards(now="2026-05-28T12:45:00Z") == []
    assert store.count_important_cards(now="2026-05-28T12:45:00Z") == 0


def test_baseline_reset_dry_run_requires_backup_without_mutating_operational_state(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))
    store.upsert_video(VideoRecord(video_id="old-video", channel_id=channel.id, title="Old", lifecycle="ignored_seen"))
    store.upsert_rejected_video(video_id="old-video", source_country="colombia", reason="no_title_match")

    report = store.reset_radar_baseline(mode="dry-run", backup_path=tmp_path / "missing.bak", baseline_started_at="2026-05-28T20:00:00Z")

    assert report["status"] == "dry-run"
    assert report["videos_planned"] == 1
    assert report["backup_exists"] is False
    assert store.get_video("old-video") is not None
    assert store.find_channel_by_youtube_id("UCCaracol").baseline_started_at is None


def test_baseline_reset_apply_creates_backup_preserves_channels_and_stamps_baseline(tmp_path):
    db_path = tmp_path / "monitor.sqlite3"
    backup_path = tmp_path / "monitor.sqlite3.baseline.bak"
    store = MonitorStore(db_path)
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol", enabled=True))
    store.upsert_channel(ChannelRecord(country="ecuador", label="Disabled", source_url=None, youtube_channel_id="UCDisabled", uploads_playlist_id="UUDisabled", enabled=False))
    store.upsert_video(VideoRecord(video_id="old-video", channel_id=channel.id, title="Old", lifecycle="ignored_seen"))
    store.upsert_target_match(TargetMatchRecord(video_id="old-video", target_country="ecuador", status="aprobado"))
    store.upsert_rejected_video(video_id="old-video", source_country="colombia", reason="no_valid_target_match")

    report = store.reset_radar_baseline(mode="apply", backup_path=backup_path, baseline_started_at="2026-05-28T20:00:00Z")

    assert report["status"] == "applied"
    assert Path(report["backup_path"]).exists()
    assert store.get_video("old-video") is None
    assert store.find_channel_by_youtube_id("UCCaracol").baseline_started_at == "2026-05-28T20:00:00Z"
    assert store.find_channel_by_youtube_id("UCCaracol").last_seen_published_at is None
    assert store.find_channel_by_youtube_id("UCDisabled").baseline_started_at is None
    assert [channel.youtube_channel_id for channel in store.list_channels()] == ["UCCaracol", "UCDisabled"]


def test_store_updates_catchup_checkpoint_monotonically_and_records_error(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", uploads_playlist_id="UUCaracol"))

    store.stamp_channel_baseline(channel.id, baseline_started_at="2026-05-28T20:00:00Z")
    store.advance_channel_catchup_checkpoint(channel.id, published_at="2026-05-28T20:10:00Z", caught_up_at="2026-05-28T20:11:00Z")
    store.advance_channel_catchup_checkpoint(channel.id, published_at="2026-05-28T20:05:00Z", caught_up_at="2026-05-28T20:12:00Z")
    store.record_channel_catchup_error(channel.id, error="metadata_failed", caught_up_at="2026-05-28T20:13:00Z")

    updated = store.find_channel_by_youtube_id("UCCaracol")
    assert updated.baseline_started_at == "2026-05-28T20:00:00Z"
    assert updated.last_seen_published_at == "2026-05-28T20:10:00Z"
    assert updated.last_catchup_error == "metadata_failed"
    assert updated.last_catchup_at == "2026-05-28T20:13:00Z"


def test_store_active_window_filters_all_visible_radar_views(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol", important=True))
    for video_id, detected_at in [("active", "2026-05-27T12:00:00Z"), ("expired", "2026-05-20T12:00:00Z")]:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=video_id, lifecycle="enqueue_pending", matched=True, detected_at=detected_at))
        store.upsert_target_match(TargetMatchRecord(video_id=video_id, target_country="ecuador", status="aprobado"))
        store.upsert_rejected_video(video_id=video_id, source_country="colombia", reason="test")
        queue = store.enqueue_ai_rescue_rejected_video(video_id=video_id, now=detected_at)
        store.store_ai_rescue_candidate(queue_id=queue.id, video_id=video_id, target_country="ecuador", score=80, summary_es="ok", angle_es="ok", risk="low")
        store.store_ai_rescue_rejection(queue_id=queue.id, video_id=video_id, target_country="mexico", source="ai", reason="weak")

    assert [card.video_id for card in store.list_monitor_cards(now="2026-05-28T12:00:00Z", limit=10)] == ["active"]
    assert [card["video_id"] for card in store.list_target_cards(target_country="ecuador", now="2026-05-28T12:00:00Z", limit=10)] == ["active"]
    assert [card["video_id"] for card in store.list_important_cards(now="2026-05-28T12:00:00Z", limit=10)] == ["active"]
    assert [item.video_id for item in store.list_rejected_videos(now="2026-05-28T12:00:00Z", limit=10).items] == ["active"]
    assert [item.video_id for item in store.list_ai_rescue_candidates(now="2026-05-28T12:00:00Z")] == ["active"]
    assert [item.video_id for item in store.list_ai_rescue_rejections(now="2026-05-28T12:00:00Z")] == ["active"]


def test_store_records_classification_runs_and_stale_candidates_without_promoting_lifecycle(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.upsert_video(VideoRecord(video_id="stale", channel_id=channel.id, title="Ecuador", lifecycle="ignored_seen"))

    candidates = store.list_stale_classification_candidates(classification_version="title-country-v1", limit=10)
    run = store.create_classification_run(
        classification_version="title-country-v1",
        mode="apply",
        candidate_count=len(candidates),
        parameters_json='{"limit":10}',
    )
    store.finish_classification_run(
        run.id,
        status="completed",
        would_create_matches=1,
        would_create_rejections=0,
        created_or_updated_matches=1,
        created_or_updated_rejections=0,
        skipped_in_flight=0,
    )

    assert [candidate.video.video_id for candidate in candidates] == ["stale"]
    assert candidates[0].source_country == "colombia"
    assert store.get_classification_run(run.id).created_or_updated_matches == 1
    assert store.get_video("stale").lifecycle == "ignored_seen"


def test_important_audit_backfill_dry_run_counts_candidates_without_mutating_protected_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important_mode="full_channel")
    )
    normal_channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCNormal")
    )
    store.upsert_video(VideoRecord(video_id="candidate", channel_id=important_channel.id, title="Any VOD", lifecycle="enqueue_pending", matched=True))
    store.upsert_video(VideoRecord(video_id="normal", channel_id=normal_channel.id, title="Ecuador", lifecycle="enqueue_pending", matched=True))
    store.upsert_video(VideoRecord(video_id="protected", channel_id=important_channel.id, title="Protected", lifecycle="enqueued", matched=True))
    store.upsert_target_match(TargetMatchRecord(video_id="protected", target_country="ecuador", status="transcribiendo", radar_job_id="job-protected"))

    report = store.backfill_important_audit(mode="dry-run", classification_version="important-audit-v1")

    assert report == {"candidate_count": 1, "updated_videos": 0, "updated_target_matches": 0, "skipped_protected": 1}
    assert store.get_video("candidate").important_mode is None
    assert store.list_target_matches(video_id="protected")[0].status == "transcribiendo"


def test_important_audit_backfill_apply_sets_readable_audit_fields_and_skips_terminal_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    important_channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important_mode="full_channel")
    )
    store.upsert_video(VideoRecord(video_id="candidate", channel_id=important_channel.id, title="Any VOD", lifecycle="enqueue_pending", matched=True))
    for status in ["transcribiendo", "transcrito", "error", "geo_blocked"]:
        video_id = f"protected-{status}"
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=important_channel.id, title=status, lifecycle="enqueued", matched=True))
        store.upsert_target_match(TargetMatchRecord(video_id=video_id, target_country="ecuador", status=status, radar_job_id=f"job-{status}"))

    report = store.backfill_important_audit(mode="apply", classification_version="important-audit-v1")

    video = store.get_video("candidate")

    assert report == {"candidate_count": 1, "updated_videos": 1, "updated_target_matches": 0, "skipped_protected": 4}
    assert video.important_mode == "full_channel"
    assert json.loads(video.important_rule_json)[0] == {"type": "important_full_channel", "label": "NSports", "source_country": "argentina"}
    assert video.queue_priority_tier == "important"
    assert video.queue_priority_rank == 0
    assert video.classification_version == "important-audit-v1"
    protected = store.list_target_matches(video_id="protected-transcrito")[0]
    assert (protected.status, protected.radar_job_id) == ("transcrito", "job-transcrito")


def test_store_applies_classification_idempotently_and_skips_protected_target_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.upsert_video(VideoRecord(video_id="safe", channel_id=channel.id, title="Ecuador", lifecycle="ignored_seen"))
    store.upsert_video(VideoRecord(video_id="protected", channel_id=channel.id, title="Ecuador", lifecycle="enqueued"))
    store.upsert_target_match(
        TargetMatchRecord(video_id="protected", target_country="ecuador", status="transcribiendo", radar_job_id="job-1")
    )

    first = store.apply_classification(
        video_id="safe",
        source_country="colombia",
        target_countries=["ecuador"],
        status="approved",
        reason="target_match",
        match_reason_json='[{"country":"ecuador"}]',
        classification_version="title-country-v1",
        classification_run_id=1,
        classified_at="2026-05-22T10:00:00Z",
    )
    second = store.apply_classification(
        video_id="safe",
        source_country="colombia",
        target_countries=["ecuador"],
        status="approved",
        reason="target_match",
        match_reason_json='[{"country":"ecuador"}]',
        classification_version="title-country-v1",
        classification_run_id=2,
        classified_at="2026-05-22T10:01:00Z",
    )
    skipped = store.apply_classification(
        video_id="protected",
        source_country="colombia",
        target_countries=["ecuador"],
        status="approved",
        reason="target_match",
        match_reason_json='[{"country":"ecuador"}]',
        classification_version="title-country-v1",
        classification_run_id=2,
        classified_at="2026-05-22T10:01:00Z",
    )

    assert first == {"created_or_updated_matches": 1, "created_or_updated_rejections": 0, "skipped_in_flight": 0}
    assert second == first
    assert skipped == {"created_or_updated_matches": 0, "created_or_updated_rejections": 0, "skipped_in_flight": 1}
    assert len(store.list_target_matches(video_id="safe")) == 1
    assert store.list_target_matches(video_id="protected")[0].radar_job_id == "job-1"


def test_store_reads_audit_fields_from_video_target_and_enqueue_records(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.upsert_video(
        VideoRecord(
            video_id="audit-video",
            channel_id=channel.id,
            title="Ecuador",
            lifecycle="enqueue_pending",
            matched=True,
            important_mode="program_rules",
            important_rule_json='{"op":"contains","value":"TENORES"}',
            queue_priority_tier="ecuador:algorithm_priority",
            queue_priority_rank=10,
            classification_version="important-audit-v1",
        )
    )
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="audit-video",
            target_country="ecuador",
            status="aprobado",
            queue_priority_tier="ecuador:algorithm_priority",
            queue_priority_rank=10,
            classification_version="important-audit-v1",
        )
    )
    store.record_enqueue_attempt(
        video_id="audit-video",
        status="enqueued",
        radar_job_id="job-audit",
        queue_priority_tier="ecuador:algorithm_priority",
        queue_priority_rank=10,
    )

    video = store.get_video("audit-video")
    match = store.list_target_matches(video_id="audit-video")[0]
    attempt = store.list_enqueue_attempts("audit-video")[0]

    assert video.important_mode == "program_rules"
    assert video.important_rule_json == '{"op":"contains","value":"TENORES"}'
    assert video.queue_priority_tier == "ecuador:algorithm_priority"
    assert video.queue_priority_rank == 10
    assert match.queue_priority_tier == "ecuador:algorithm_priority"
    assert match.queue_priority_rank == 10
    assert attempt.queue_priority_tier == "ecuador:algorithm_priority"
    assert attempt.queue_priority_rank == 10


def test_store_persists_one_target_match_per_video_and_target_country(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(video_id="multi-target", channel_id=channel.id, title="Ecuador y México", lifecycle="enqueue_pending")
    )

    first = store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi-target",
            target_country="ecuador",
            status="aprobado",
            title_match_reason='[{"country":"ecuador"}]',
        )
    )
    second = store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi-target",
            target_country="mexico",
            status="aprobado",
            title_match_reason='[{"country":"mexico"}]',
        )
    )
    updated = store.upsert_target_match(
        TargetMatchRecord(
            video_id="multi-target",
            target_country="ecuador",
            status="transcribiendo",
            radar_job_id="radar-1",
            title_match_reason='[{"country":"ecuador"}]',
        )
    )

    matches = store.list_target_matches(video_id="multi-target")

    assert first.id == updated.id
    assert second.id != first.id
    assert [(match.target_country, match.status, match.radar_job_id) for match in matches] == [
        ("ecuador", "transcribiendo", "radar-1"),
        ("mexico", "aprobado", None),
    ]


def test_list_due_enqueue_sorts_important_before_country_jobs(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="argentina", label="Normal", source_url=None, youtube_channel_id="UCNormal"))
    important_channel = store.upsert_channel(ChannelRecord(country="peru", label="Mr Peet", source_url=None, youtube_channel_id="UCImportant", important_mode="program_rules"))
    store.upsert_video(VideoRecord(video_id="ecuador", channel_id=channel.id, title="Ecuador", url="https://youtu.be/ec", lifecycle="enqueue_pending", matched=True))
    store.upsert_target_match(store.make_target_match(video_id="ecuador", target_country="ecuador", status="aprobado"))
    store.upsert_video(
        VideoRecord(
            video_id="important",
            channel_id=important_channel.id,
            title="Madrugol",
            url="https://youtu.be/important",
            lifecycle="enqueue_pending",
            matched=True,
            important_mode="program_rules",
            queue_priority_tier="important",
            queue_priority_rank=0,
        )
    )

    due = store.list_due_enqueue("2026-05-20T10:00:00Z")

    assert [video.video_id for video in due] == ["important"]


def test_list_due_enqueue_excludes_normal_approved_matches_but_keeps_cards_visible(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol"))
    store.upsert_video(
        VideoRecord(
            video_id="normal-approved",
            channel_id=channel.id,
            title="Ecuador mira a Colombia",
            url="https://youtu.be/normal-approved",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="normal-approved", target_country="ecuador", status="aprobado"))

    due = store.list_due_enqueue("2026-05-20T10:00:00Z")
    cards = store.list_target_cards(target_country="ecuador")

    assert due == []
    assert [(card["video_id"], card["status"], card["radar_job_id"]) for card in cards] == [
        ("normal-approved", "aprobado", None)
    ]


def test_list_due_enqueue_uses_country_pyramid_for_important_jobs_not_lexicographic_order(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(ChannelRecord(country="spain", label="Normal", source_url=None, youtube_channel_id="UCNormal"))
    for video_id, country in [
        ("mexico", "mexico"),
        ("paraguay", "paraguay"),
        ("uruguay", "uruguay"),
        ("argentina", "argentina"),
        ("colombia", "colombia"),
        ("ecuador", "ecuador"),
    ]:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title=country, url=f"https://youtu.be/{video_id}", lifecycle="enqueue_pending", matched=True, classification_status="important", important_mode="program_rules"))
        store.upsert_target_match(store.make_target_match(video_id=video_id, target_country=country, status="aprobado"))

    due = store.list_due_enqueue("2026-05-20T10:00:00Z")

    assert [video.video_id for video in due] == ["ecuador"]


def test_list_due_enqueue_sorts_important_algorithm_priority_with_stable_tiebreakers(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    priority = store.upsert_channel(ChannelRecord(country="spain", label="Priority", source_url=None, youtube_channel_id="UCPriority", algorithm_priority_rank=3))
    lower_priority = store.upsert_channel(ChannelRecord(country="spain", label="Lower", source_url=None, youtube_channel_id="UCLower", algorithm_priority_rank=9))
    normal = store.upsert_channel(ChannelRecord(country="spain", label="Normal", source_url=None, youtube_channel_id="UCNormal"))
    for video_id, channel in [("normal-old", normal), ("priority-lower", lower_priority), ("priority-best-b", priority), ("priority-best-a", priority)]:
        store.upsert_video(VideoRecord(video_id=video_id, channel_id=channel.id, title="Ecuador", url=f"https://youtu.be/{video_id}", lifecycle="enqueue_pending", matched=True, classification_status="important", important_mode="program_rules"))
        store.upsert_target_match(store.make_target_match(video_id=video_id, target_country="ecuador", status="aprobado"))
        store.force_video_created_at(video_id, "2026-05-20T09:00:00Z")

    due = store.list_due_enqueue("2026-05-20T10:00:00Z")

    assert [video.video_id for video in due] == ["priority-best-a"]


def test_list_transcribing_video_jobs_includes_important_enqueue_attempt_without_target_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="important-job",
            channel_id=channel.id,
            title="Important without target rows",
            lifecycle="enqueued",
            matched=True,
            classification_status="important_channel",
        )
    )
    store.record_enqueue_attempt(video_id="important-job", status="enqueued", radar_job_id="job-important")

    assert store.list_target_matches(video_id="important-job") == []
    assert store.list_transcribing_video_jobs() == [{"video_id": "important-job", "radar_job_id": "job-important"}]


def test_upsert_important_summary_country_matches_creates_real_countries_only(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="NSports",
            source_url=None,
            youtube_channel_id="UCImportant",
            important=True,
            priority_tier="importantes",
        )
    )
    store.upsert_video(VideoRecord(video_id="important-summary", channel_id=channel.id, lifecycle="enqueued", matched=True))

    store.upsert_important_summary_country_matches(
        video_id="important-summary",
        radar_job_id="job-important",
        summary={
            "items": [
                {"country": "Argentina", "label": "Argentina", "count": 2},
                {"country": "mexico", "label": "México", "count": 1},
                {"country": "Uruguay", "label": "Uruguay", "count": 0},
                {"country": "", "label": "Blank", "count": 3},
                {"country": "IMPORTANTES", "label": "Important", "count": 9},
                {"country": "peru", "label": "Perú", "count": 4},
            ]
        },
    )

    assert [
        (match.target_country, match.status, match.radar_job_id, match.approval_source, match.mention_counts_json)
        for match in store.list_target_matches(video_id="important-summary")
    ] == [
        ("mexico", "transcrito", "job-important", "transcript_summary", '[{"label":"México","count":1}]'),
    ]


def test_important_summary_mentions_store_global_counts_sorted_without_synthetic_country_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="NSports", source_url=None, youtube_channel_id="UCImportant", important=True)
    )
    store.upsert_video(VideoRecord(video_id="important-global", channel_id=channel.id, lifecycle="enqueued", matched=True, detected_at="2026-05-28T10:00:00Z"))

    store.upsert_important_summary_mentions(
        video_id="important-global",
        radar_job_id="job-global",
        summary={
            "items": [
                {"country": "chile", "label": "Chile", "count": 2},
                {"country": "argentina", "label": "Argentina", "count": 5},
                {"country": "peru", "label": "Perú", "count": 0},
            ]
        },
    )

    cards = store.list_important_cards(now="2026-05-28T12:00:00Z")
    with sqlite3.connect(tmp_path / "monitor.sqlite3") as connection:
        synthetic_rows = connection.execute(
            "select count(*) from video_target_matches where target_country in ('important', 'importantes')"
        ).fetchone()[0]

    assert cards[0]["mention_counts_json"] == '[{"label":"Argentina","count":5},{"label":"Chile","count":2}]'
    assert cards[0]["radar_job_id"] == "job-global"
    assert synthetic_rows == 0


def test_important_audit_backfill_reclassifies_recent_rejected_full_channel_and_program_rule_rows(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    full_channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Carlos Antonio Vélez", source_url=None, youtube_channel_id="UCCarlos", important_mode="full_channel")
    )
    program_channel = store.upsert_channel(
        ChannelRecord(
            country="peru",
            label="Mr Peet",
            source_url=None,
            youtube_channel_id="UCMrPeet",
            important_mode="program_rules",
            important_rules=[ImportantRule(op="contains", value="Madrugol", content_types=["completed"])],
        )
    )
    protected_channel = store.upsert_channel(
        ChannelRecord(country="argentina", label="Protected", source_url=None, youtube_channel_id="UCProtected", important_mode="full_channel")
    )
    store.upsert_video(VideoRecord(video_id="carlos", channel_id=full_channel.id, title="Análisis sin país", lifecycle="ignored_seen", matched=False, live_status="none"))
    store.upsert_rejected_video(video_id="carlos", source_country="colombia", reason="no_title_match")
    store.upsert_video(VideoRecord(video_id="madrugol", channel_id=program_channel.id, title="Madrugol con Mr Peet", lifecycle="ignored_seen", matched=False, live_status="none"))
    store.upsert_rejected_video(video_id="madrugol", source_country="peru", reason="no_title_match")
    store.upsert_video(VideoRecord(video_id="protected", channel_id=protected_channel.id, title="Protected", lifecycle="enqueued", matched=True))
    store.record_enqueue_attempt(video_id="protected", status="enqueued", radar_job_id="job-protected")

    dry_run = store.backfill_important_audit(mode="dry-run", classification_version="important-audit-v1")
    applied = store.backfill_important_audit(mode="apply", classification_version="important-audit-v1")

    assert dry_run == {"candidate_count": 2, "updated_videos": 0, "updated_target_matches": 0, "skipped_protected": 1}
    assert applied == {"candidate_count": 2, "updated_videos": 2, "updated_target_matches": 0, "skipped_protected": 1}
    assert [(store.get_video(video_id).lifecycle, store.get_video(video_id).queue_priority_tier, store.get_video(video_id).important_mode) for video_id in ["carlos", "madrugol"]] == [
        ("enqueue_pending", "important", "full_channel"),
        ("enqueue_pending", "important", "program_rules"),
    ]
    assert json.loads(store.get_video("madrugol").important_rule_json)[0]["value"] == "Madrugol"
    assert store.get_video("protected").lifecycle == "enqueued"


def test_update_target_matches_from_summary_scopes_existing_rows_and_discovers_positive_countries(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="mexico", label="TUDN", source_url=None, youtube_channel_id="UCTudn")
    )
    store.upsert_video(
        VideoRecord(
            video_id="summary-scoped",
            channel_id=channel.id,
            lifecycle="enqueued",
            matched=True,
            classification_version="title-country-v1",
            classified_at="2026-05-20T10:00:00Z",
            classification_run_id=7,
        )
    )
    store.upsert_target_match(store.make_target_match(video_id="summary-scoped", target_country="ecuador", status="transcribiendo", radar_job_id="job-scoped"))
    store.upsert_target_match(
        TargetMatchRecord(
            video_id="summary-scoped",
            target_country="colombia",
            status="transcribiendo",
            radar_job_id="job-scoped",
            approval_source="ai_rescue",
        )
    )

    store.update_target_matches_from_summary(
        video_id="summary-scoped",
        radar_job_id="job-scoped",
        summary={
            "items": [
                {"country": "colombia", "label": "James Rodríguez", "count": 2},
                {"country": "uruguay", "label": "Uruguay", "count": 1},
                {"country": "argentina", "label": "Argentina", "count": 0},
                {"country": "mexico", "label": "México", "count": 4},
            ]
        },
    )

    assert [
        (match.target_country, match.status, match.radar_job_id, match.approval_source, match.mention_counts_json)
        for match in store.list_target_matches(video_id="summary-scoped")
    ] == [
        ("ecuador", "transcrito", "job-scoped", "title_classifier", "[]"),
        ("colombia", "transcrito", "job-scoped", "ai_rescue", '[{"label":"James Rodríguez","count":2}]'),
        ("uruguay", "transcrito", "job-scoped", "transcript_summary", '[{"label":"Uruguay","count":1}]'),
    ]


def test_store_retains_rejected_videos_with_paging_and_never_mixes_approved_matches(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(VideoRecord(video_id="approved", channel_id=channel.id, title="Ecuador", lifecycle="enqueue_pending"))
    store.upsert_target_match(TargetMatchRecord(video_id="approved", target_country="ecuador", status="aprobado"))
    store.upsert_video(VideoRecord(video_id="trash-1", channel_id=channel.id, title="Solo Colombia", lifecycle="ignored_seen"))
    store.upsert_rejected_video(
        video_id="trash-1",
        source_country="colombia",
        reason="no_valid_target_match",
        match_reason_json='[{"country":"colombia"}]',
    )
    store.upsert_video(VideoRecord(video_id="trash-2", channel_id=channel.id, title="Nada", lifecycle="ignored_seen"))
    store.upsert_rejected_video(
        video_id="trash-2",
        source_country="colombia",
        reason="no_title_match",
        match_reason_json="[]",
    )

    first_page = store.list_rejected_videos(limit=1, offset=0)
    second_page = store.list_rejected_videos(limit=1, offset=1)

    assert first_page.total == 2
    assert [entry.video_id for entry in first_page.items] == ["trash-2"]
    assert [entry.video_id for entry in second_page.items] == ["trash-1"]
    assert all(entry.video_id != "approved" for entry in first_page.items + second_page.items)


def test_list_monitor_cards_joins_videos_channels_and_latest_enqueue_attempt(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()
    channel = store.upsert_channel(
        ChannelRecord(
            country="argentina",
            label="TyC Sports",
            source_url="https://www.youtube.com/@tycsports",
            youtube_channel_id="UCTyC",
        )
    )
    store.upsert_video(
        VideoRecord(
            video_id="video-1",
            channel_id=channel.id,
            title="Messi y la selección",
            url="https://youtu.be/video-1",
            published_at="2026-05-21T12:00:00Z",
            lifecycle="enqueue_pending",
            matched=True,
        )
    )
    store.record_enqueue_attempt(video_id="video-1", status="failed", last_error="temporary outage")
    store.record_enqueue_attempt(video_id="video-1", status="submitted", radar_job_id="radar-job-1")

    cards = store.list_monitor_cards(limit=10)

    assert len(cards) == 1
    assert cards[0].video_id == "video-1"
    assert cards[0].title == "Messi y la selección"
    assert cards[0].country == "argentina"
    assert cards[0].channel_label == "TyC Sports"
    assert cards[0].published_at == "2026-05-21T12:00:00Z"
    assert cards[0].lifecycle == "enqueue_pending"
    assert cards[0].matched is True
    assert cards[0].enqueue_status == "submitted"
    assert cards[0].radar_job_id == "radar-job-1"
    assert cards[0].attempt_count == 2
    assert cards[0].last_error is None


def test_list_monitor_cards_keeps_missing_linkage_and_empty_state_explicit(tmp_path):
    store = MonitorStore(tmp_path / "monitor.sqlite3")
    store.migrate()

    assert store.list_monitor_cards(limit=10) == []

    channel = store.upsert_channel(
        ChannelRecord(country="colombia", label="Caracol Deportes", source_url=None, youtube_channel_id="UCCaracol")
    )
    store.upsert_video(
        VideoRecord(
            video_id="video-without-job",
            channel_id=channel.id,
            title="Previa Colombia",
            lifecycle="ignored_seen",
            matched=False,
        )
    )

    cards = store.list_monitor_cards(limit=10)

    assert len(cards) == 1
    assert cards[0].video_id == "video-without-job"
    assert cards[0].enqueue_status is None
    assert cards[0].radar_job_id is None
    assert cards[0].attempt_count is None
    assert cards[0].last_error is None
