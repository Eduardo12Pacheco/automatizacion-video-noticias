from __future__ import annotations

import pytest

from newsroom_media.url_guard import BlockedUrlError, assert_public_url, is_blocked_address


def public_resolver(_host: str) -> list[str]:
    return ["93.184.216.34"]


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/article",
        "http://10.1.2.3/article",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.0.1/article",
        "http://[::1]/article",
        "http://[::ffff:127.0.0.1]/article",
        "http://[fd00::1]/article",
        "http://0.0.0.0/article",
        "http://224.0.0.1/article",
    ],
)
def test_blocks_private_and_non_public_literal_hosts(url: str) -> None:
    with pytest.raises(BlockedUrlError):
        assert_public_url(url, resolver=public_resolver)


@pytest.mark.parametrize(
    "url",
    [
        "http://approval-editor:3042/api/projects",
        "http://localhost:8080/",
        "http://api.local/",
        "http://service.internal/",
        "file:///etc/passwd",
        "not a url",
    ],
)
def test_blocks_single_label_and_non_http_urls(url: str) -> None:
    with pytest.raises(BlockedUrlError):
        assert_public_url(url, resolver=public_resolver)


def test_blocks_public_looking_names_that_resolve_inward() -> None:
    with pytest.raises(BlockedUrlError):
        assert_public_url("https://news.example.com/story", resolver=lambda _host: ["10.0.0.9"])
    with pytest.raises(BlockedUrlError):
        assert_public_url(
            "https://news.example.com/story",
            resolver=lambda _host: ["93.184.216.34", "169.254.169.254"],
        )


def test_accepts_public_urls() -> None:
    assert assert_public_url("https://news.example.com/story", resolver=public_resolver) == "https://news.example.com/story"
    assert is_blocked_address("93.184.216.34") is False
    assert is_blocked_address("100.64.1.1") is True
    assert is_blocked_address("::ffff:a00:1") is True


def test_guarded_opener_rechecks_redirect_targets() -> None:
    from newsroom_media.url_guard import build_guarded_opener

    opener = build_guarded_opener(resolver=public_resolver)
    handler = next(
        candidate
        for candidate in opener.handlers
        if candidate.__class__.__name__ == "_GuardedRedirect"
    )
    with pytest.raises(BlockedUrlError):
        handler.redirect_request(
            None, None, 302, "Found", {}, "http://169.254.169.254/latest/meta-data/"
        )
