"""Server-side URL guard for values that come from news or user data.

Article extraction and media downloads are handed URLs that originated in RSS
feeds or job rows. Before any socket is opened, reject loopback, private,
link-local, CGNAT/shared, multicast, reserved and unspecified addresses, any
IPv6 equivalent, and single-label hosts (Docker Compose service names such as
``approval-editor``). Hostnames are resolved and every returned address must be
public; redirects are checked again because a public URL can redirect inward.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Callable
from urllib.parse import urlparse

AddressResolver = Callable[[str], list[str]]


class BlockedUrlError(RuntimeError):
    """Raised when a URL could reach a non-public network destination."""

    def __init__(self, message: str = "url is not a public http(s) destination") -> None:
        self.code = "ssrf_blocked_url"
        super().__init__(message)


_BLOCKED_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::1/128",
        "::ffff:0:0/96",
        "64:ff9b::/96",
        "100::/64",
        "2001:db8::/32",
        "fc00::/7",
        "fe80::/10",
        "ff00::/8",
    )
)


def _default_resolver(host: str) -> list[str]:
    addresses: set[str] = set()
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None):
        if family in {socket.AF_INET, socket.AF_INET6} and sockaddr:
            addresses.add(str(sockaddr[0]))
    return sorted(addresses)


def is_blocked_address(value: str) -> bool:
    """Return True when an IP literal is not a public unicast address."""

    try:
        address = ipaddress.ip_address(str(value).strip())
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if address.is_private or address.is_loopback or address.is_link_local:
        return True
    if address.is_multicast or address.is_unspecified or address.is_reserved:
        return True
    return any(address in network for network in _BLOCKED_NETWORKS if network.version == address.version)


def _assert_host(host: str) -> str:
    normalized = host.strip().casefold().rstrip(".")
    if not normalized:
        raise BlockedUrlError("url has no host")
    if normalized == "localhost" or normalized.endswith(".localhost"):
        raise BlockedUrlError("url host is not public")
    if normalized.endswith((".local", ".internal", ".lan")):
        raise BlockedUrlError("url host is not public")
    try:
        address = ipaddress.ip_address(normalized)
    except ValueError:
        address = None
    if address is not None:
        if is_blocked_address(str(address)):
            raise BlockedUrlError("url host is not public")
        return normalized
    # A single-label name is a Docker Compose service or LAN host, never a
    # public news site.
    if "." not in normalized:
        raise BlockedUrlError("url host is a single-label name")
    return normalized


def assert_public_url(url: str, *, resolver: AddressResolver | None = None) -> str:
    """Return the URL unchanged or raise BlockedUrlError."""

    parsed = urlparse(str(url or ""))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise BlockedUrlError("url must be an absolute http(s) url")
    host = _assert_host(parsed.hostname)
    if _is_ip(host):
        return url
    resolve = resolver or _default_resolver
    try:
        addresses = resolve(host)
    except OSError as exc:
        raise BlockedUrlError("url host could not be resolved") from exc
    if not addresses:
        raise BlockedUrlError("url host resolved to no addresses")
    for address in addresses:
        if is_blocked_address(address):
            raise BlockedUrlError("url host resolves to a non-public address")
    return url


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def build_guarded_opener(*, resolver: AddressResolver | None = None):
    """Return a urllib opener that re-checks each redirect target."""

    from urllib.request import HTTPHandler, HTTPRedirectHandler, HTTPSHandler, build_opener

    class _GuardedRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802 - urllib API
            assert_public_url(newurl, resolver=resolver)
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    return build_opener(HTTPHandler(), HTTPSHandler(), _GuardedRedirect())
