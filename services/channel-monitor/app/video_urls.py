"""Canonical public YouTube URL for a video id."""

from __future__ import annotations


def video_watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"
