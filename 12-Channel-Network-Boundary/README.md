# Channel Network Boundary

Cloud/server boundary for Channel Monitor network-sensitive YouTube, subtitle, and WebSub operations.

The boundary supports explicit `mock` and `youtube` provider modes. Mock mode is safe for local contract checks; `youtube` mode performs cloud-side Data API, timedtext, and WebSub hub operations only when the required environment is configured.

## Run locally for contract tests

```powershell
$env:CHANNEL_BOUNDARY_API_TOKEN = "replace-with-dev-token"
python -m uvicorn app:create_app --factory --app-dir 12-Channel-Network-Boundary --host 127.0.0.1 --port 8088
```

## Boundary mock smoke

Use `scripts\smoke-mock-boundary.ps1` after the boundary app is already running locally with the mock provider. The script does not start the service, does not deploy, does not use real secrets, and only calls loopback URLs.

```powershell
$env:CHANNEL_BOUNDARY_API_TOKEN = "replace-with-dev-token"
12-Channel-Network-Boundary\scripts\smoke-mock-boundary.ps1

# Optional local-only outage/misconfig simulation against an unused loopback port.
12-Channel-Network-Boundary\scripts\smoke-mock-boundary.ps1 -CheckOutage
```

The smoke checks `/health`, performs a mocked `/v1/videos/metadata` request with `Authorization: Bearer ...`, redacts the token in output, and documents expected fail-closed behavior when the boundary base URL is unreachable.

## Safe Cloud Run rollout

Use this order. Do not swap steps, because protected Channel Monitor must not run against an unverified real provider boundary.

1. **Deploy boundary** with `CHANNEL_BOUNDARY_PROVIDER=youtube` and Secret Manager references only.
2. **Smoke cloud** against the deployed boundary URL: `/health`, provider mode, metadata/uploads/subtitles/WebSub samples.
3. Only after smoke passes, configure/restart `radar-channel-monitor` in protected mode.

### Deploy boundary

`scripts\deploy-cloud-run-boundary.ps1` prepares a safe Cloud Run deploy command. It requires Secret Manager references such as `channel-boundary-api-token:latest`; it rejects raw token or API key values and does not print secrets.

```powershell
12-Channel-Network-Boundary\scripts\deploy-cloud-run-boundary.ps1 `
  -ProjectId "your-gcp-project" `
  -Region "us-central1" `
  -ServiceName "channel-network-boundary" `
  -Image "us-docker.pkg.dev/your-gcp-project/boundary/channel-network-boundary:tag" `
  -ApiTokenSecretRef "channel-boundary-api-token:latest" `
  -YouTubeApiKeySecretRef "channel-boundary-youtube-api-key:latest" `
  -WebSubVerifyTokenSecretRef "channel-boundary-websub-verify-token:latest" `
  -LocalEventApiKeySecretRef "channel-boundary-local-event-api-key:latest" `
  -PublicCallbackUrl "https://boundary.example.com/v1/websub/callback" `
  -LocalEventUrl "https://monitor.example.com/api/monitor/boundary/websub-events" `
  -NoTraffic

# Add -ConfirmDeploy only when the reviewed command is ready to run.
```

### Smoke cloud

Do not run this script from CI. It is an operator smoke for an already deployed Cloud Run/API Gateway URL and may make live YouTube/hub calls through the boundary. It does not deploy and does not restart services.

```powershell
$env:CHANNEL_BOUNDARY_API_TOKEN = "paste-operator-token-without-logging-it"
12-Channel-Network-Boundary\scripts\smoke-cloud-boundary.ps1 `
  -BaseUrl "https://boundary.example.com" `
  -ChannelSource "@operator-approved-safe-channel" `
  -VideoId "operatorApprovedVideoId" `
  -UploadsPlaylistId "UUOperatorApprovedUploads" `
  -SubtitleLanguage "en" `
  -WebSubChannelId "UCOperatorApprovedChannel"
```

The cloud smoke checks provider mode from `/health`, then exercises resolve, metadata/uploads/subtitles/WebSub where applicable. Missing required env or a non-`youtube` provider is fail-closed; do not compensate with local YouTube fallbacks.

## Required environment

| Variable | Required | Description |
|---|---:|---|
| `CHANNEL_BOUNDARY_API_TOKEN` | Yes | Bearer token expected on `/v1/*` requests. |
| `CHANNEL_BOUNDARY_PROVIDER` | No | `mock` by default; set `CHANNEL_BOUNDARY_PROVIDER=youtube` for real cloud providers. |
| `CHANNEL_BOUNDARY_YOUTUBE_API_KEY` | For `youtube` mode | YouTube Data API key used by cloud boundary providers. |
| `CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL` | For WebSub renew in `youtube` mode | Public Cloud Run/API Gateway URL for `/v1/websub/callback`; this is the only callback sent to the hub. |
| `CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN` | Recommended | WebSub verification token checked by `GET /v1/websub/callback` when configured. |
| `CHANNEL_BOUNDARY_LOCAL_EVENT_URL` | For WebSub POST forwarding | Local/API-gateway URL for `POST /api/monitor/boundary/websub-events`. |
| `CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY` | For WebSub POST forwarding | API key sent as `x-boundary-event-api-key` when forwarding normalized WebSub events. |
| `PORT` | No | HTTP port; defaults to `8080` in Docker. |

## Endpoints

All `/v1/*` endpoints require `Authorization: Bearer <CHANNEL_BOUNDARY_API_TOKEN>` and return:

```json
{"ok": true, "data": {}}
```

or:

```json
{"ok": false, "error": {"code": "unauthorized", "message": "Missing or invalid bearer token", "retryable": false}}
```

Contract endpoints:

- `GET /health`
- `POST /v1/channels/resolve`
- `POST /v1/videos/metadata`
- `POST /v1/playlists/uploads`
- `POST /v1/subtitles/fetch`
- `POST /v1/websub/renew`
- `GET /v1/websub/callback` — public WebSub hub verification endpoint; returns the `hub.challenge` only when the configured verify token matches.
- `POST /v1/websub/callback` — public WebSub event intake; parses Atom XML, normalizes `{event_id, channel_id, video_ids, received_at}`, and forwards it to the configured local event URL using `x-boundary-event-api-key`.

## Real WebSub rollout

Use fake tests and mock smoke first. For cloud rollout, configure `CHANNEL_BOUNDARY_PROVIDER=youtube`, `CHANNEL_BOUNDARY_YOUTUBE_API_KEY`, `CHANNEL_BOUNDARY_PUBLIC_CALLBACK_URL`, `CHANNEL_BOUNDARY_WEBSUB_VERIFY_TOKEN`, `CHANNEL_BOUNDARY_LOCAL_EVENT_URL`, and `CHANNEL_BOUNDARY_LOCAL_EVENT_API_KEY` in the boundary runtime. The WebSub renewal endpoint sends the public boundary callback URL to the hub and ignores any local callback URL supplied by callers.

After deploy, smoke only operator-approved checks: `/health`, one safe resolve/metadata/uploads/subtitles sample, then one WebSub renewal with real secrets already in the cloud runtime. The smoke path does not print secrets; redact tokens/API keys in terminal output and logs. Channel Monitor remains stopped until smoke passes and the operator explicitly decides to start `radar-channel-monitor`.

Rollback: switch `CHANNEL_BOUNDARY_PROVIDER=mock` or redeploy the previous Cloud Run revision. Do not add cookies, CAPTCHA solvers, bypass tooling, local YouTube fallback, or monitor restarts as rollback steps.

## Boundary-to-local WebSub event route

The local Channel Monitor route is:

```http
POST /api/monitor/boundary/websub-events
x-boundary-event-api-key: <CHANNEL_MONITOR_BOUNDARY_EVENT_API_KEY>
```

Payload:

```json
{
  "event_id": "websub:UCExample:video-1,video-2",
  "channel_id": "UCExample",
  "video_ids": ["video-1", "video-2"],
  "received_at": "2026-06-05T12:00:00Z"
}
```

`event_id` is the idempotency key. Replays are accepted but not re-dispatched locally.

## Prohibited policy

Do **not** configure or deploy this boundary with channel-account cookies, monetized browser sessions, CAPTCHA solving, botcheck bypass credentials, or yt-dlp cookie files.

Startup validation rejects known cookie/CAPTCHA/bypass variables such as `YOUTUBE_COOKIE_FILE`, `YTDLP_COOKIES_PATH`, `CAPTCHA_API_KEY`, and `BOTCHECK_BYPASS_TOKEN`. Logs and error envelopes redact configured secret values.
