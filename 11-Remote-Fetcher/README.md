# Prensa Remote Fetcher

Small Cloud Run service that moves YouTube audio fetching outside the local Prensa machine/IP boundary.

## Endpoints

- `GET /health` — unauthenticated health check.
- `POST /fetch-audio` — authenticated audio download.

Request:

```json
{ "url": "https://www.youtube.com/watch?v=GyQFYjAc4hg" }
```

Headers:

```txt
Authorization: Bearer <FETCHER_API_TOKEN>
```

Response: audio file bytes as an attachment. Metadata is returned in `X-Prensa-Audio-Info`.

## Security boundary

This service intentionally allows only YouTube hosts and blocks private, loopback, link-local, multicast, and unresolved hosts to avoid turning Cloud Run into an open SSRF proxy.

Keep the service protected with `FETCHER_API_TOKEN`. Do not deploy it as an unauthenticated public downloader without a token.
