# Prensa / Prensa IA — Audit and Fix Plan

This document captures the current understanding of the Prensa and Prensa IA stack before implementation. The goal is to preserve context, identify risks, and define a safe staged plan for improving transcription coverage without putting the monetized YouTube channel, account, or sensitive IP reputation at risk.

## Executive summary

The problem is not the Control Panel UI. The UI is showing what the backend gives it.

The real bottleneck is the YouTube access layer:

- **Prensa** fails mostly when `09-Transcript-Service` cannot download audio with `yt-dlp` for Whisper.
- **Prensa IA** fails mostly when `10-Channel-Monitor-Service` cannot obtain subtitles/transcripts or when AI Rescue rejects evidence.
- Current backend taxonomy is too coarse: many distinct failures collapse into generic `ERROR` or `no-subtitles`.

The safest path is a staged hardening plan:

1. Fix security boundaries first.
2. Add precise backend failure taxonomy.
3. Expose actionable status to the UI.
4. Harden local `yt-dlp` with modern YouTube requirements.
5. Add transcript/audio providers only after measuring them against real failed videos.
6. Keep all YouTube automation isolated from the monetized channel identity and sensitive IP.

## Repositories in scope

| Repo | Role in Prensa / Prensa IA |
|---|---|
| `10-Api-Gateway` | Public API gateway, login/session auth, service proxy, credential injection. |
| `10-Channel-Monitor-Service` | YouTube discovery, metadata, title classification, SQLite source of truth, Radar enqueue/sync, AI Rescue queue and subtitle analysis. |
| `09-Transcript-Service` | Radar job API, `yt-dlp` audio download, ffmpeg conversion, faster-whisper transcription, mention extraction. |
| `01-Control-Panel` | Static frontend for Prensa and Prensa IA views. Displays backend status and actions. |

## Current architecture

### Prensa flow

```text
01-Control-Panel
  -> 10-Api-Gateway /monitor
  -> 10-Channel-Monitor-Service
  -> YouTube Data API metadata + title classification
  -> enqueue matched videos to 09-Transcript-Service
  -> yt-dlp downloads audio
  -> ffmpeg converts audio
  -> faster-whisper transcribes
  -> mention extraction + summary
  -> Channel Monitor syncs job status
  -> Control Panel shows cards
```

### Prensa IA flow

```text
Rejected videos in Channel Monitor
  -> ai_rescue_queue
  -> youtube_transcript_api primary subtitle provider
  -> yt-dlp subtitle fallback
  -> OpenCode Go AI analysis using subtitle evidence only
  -> candidates / rejections stored in SQLite
  -> Control Panel Prensa IA view
```

## Current production/runtime state observed

### Channel Monitor SQLite

Database: `10-Channel-Monitor-Service/runtime/monitor.sqlite3`

| Table / metric | Count |
|---|---:|
| `videos` | 4251 |
| `video_target_matches` | 202 |
| `rejected_videos` | 3782 |
| `ai_rescue_queue` | 3782 |
| `ai_rescue_candidates` | 0 |
| `ai_rescue_evidence` | 0 |
| `ai_rescue_rejections` | 9551 |

`video_target_matches.status`:

| Status | Count |
|---|---:|
| `transcrito` | 136 |
| `geo_blocked` | 40 |
| `error` | 26 |

AI Rescue queue signals:

- Waiting: ~1231
- Retry: ~453
- Current candidates: 0
- UI confirmed `0/0 CANDIDATOS`.

### Transcript Service jobs

Runtime jobs showed:

- Jobs: 332
- Succeeded: 262
- Failed: 70
- Runtime artifacts: ~23.76 GB

Failure codes:

| Failure | Count |
|---|---:|
| `yt_dlp_geo_blocked` | 37 |
| `yt_dlp_bot_check` | 25 |
| `yt_dlp_failed` | 6 |
| `yt_dlp_timeout` | 2 |

## Findings by repo

## `10-Api-Gateway`

### What it does

- Node.js ESM gateway using Node built-ins.
- Handles panel login/session cookies.
- Proxies authenticated requests to local services:
  - `/monitor` -> `http://127.0.0.1:8775`
  - `/radar` -> `http://127.0.0.1:8765`
  - `/approval` -> `http://127.0.0.1:3042`
- Strips forged sensitive headers and injects verified service credentials.

### Important risk

**Authenticated SSRF / open-proxy risk via protocol-relative paths.**

Area: `10-Api-Gateway/src/gateway.js`

If a path like this reaches the proxy:

```text
/monitor//example.com/path
```

the stripped upstream path can start with `//`, and `new URL()` can resolve it as an external URL. This requires an authenticated editor, but it is still a real gateway boundary issue.

### Proposed fix

- Reject or normalize upstream paths that begin with:
  - `//`
  - encoded protocol-relative variants
  - backslash variants
- Add regression tests for `/monitor`, `/radar`, and `/approval` paths.

### What this resolves

- Prevents authenticated users from abusing the gateway as an SSRF/open-proxy primitive.
- Hardens the service boundary before adding more provider/network complexity.

## `10-Channel-Monitor-Service`

### What it does

- Python FastAPI service.
- SQLite source of truth.
- Uses YouTube Data API for metadata/discovery.
- Classifies titles into target country/player matches.
- Enqueues matched videos to `09-Transcript-Service`.
- Syncs transcript job status back into `video_target_matches`.
- Runs AI Rescue over rejected videos using subtitles and OpenCode Go.

### Important findings

Current data shows AI Rescue is active but ineffective:

- Thousands of rejected videos in queue/history.
- Zero current candidates.
- Many `no-subtitles`, `opencode_timeout`, and `no-candidates` outcomes.

Current taxonomy is too coarse:

- Radar shows `geo_blocked` but collapses bot-check, timeout, live/copyright, and generic download failures into `error`.
- AI Rescue collapses detailed subtitle provider reasons into `no-subtitles`.

### Proposed fixes

1. Add normalized error categories for Radar sync:
   - `youtube_geo_blocked`
   - `youtube_bot_check`
   - `youtube_download_timeout`
   - `youtube_live_pending`
   - `youtube_copyright_blocked`
   - `radar_rejected`
   - `runtime_misconfigured`

2. Preserve provider details for AI Rescue:
   - provider: `youtube_transcript_api` or `yt_dlp`
   - provider reason: `transcripts_disabled`, `no_transcript`, `language_unavailable`, `video_unavailable`, `fetch_error`, `no_subtitles`, `empty_transcript`
   - retryable: true/false
   - fallback used: true/false

3. Add telemetry counters by provider, operation, reason, country, and retry count.

4. Add safer retry rules:
   - geo-block: terminal for same IP/region.
   - copyright: terminal.
   - live/upcoming: reschedule later.
   - bot-check: cooldown, do not retry aggressively.
   - timeout/network: bounded retry with jitter.

### What this resolves

- Makes `ERROR` actionable.
- Explains why Prensa IA has no candidates.
- Prevents blind retry loops that worsen YouTube/IP reputation.
- Gives the UI enough information to show useful operator labels.

## `09-Transcript-Service`

### What it does

- Python FastAPI service.
- Accepts Radar transcription jobs.
- Uses `yt-dlp` to fetch YouTube title and audio.
- Uses ffmpeg to convert to 16kHz audio.
- Uses faster-whisper on CUDA for transcription.
- Extracts target mentions and writes job artifacts.

### Important risks

1. URL validation is too broad:
   - Blocks literal localhost/private IPs.
   - Does not DNS-resolve hostnames to prevent private/internal IP resolution.
   - Accepts broad `http`/`https` hosts instead of YouTube-only for this workflow.

2. Downloads are not bounded enough:
   - No max duration.
   - No max filesize.
   - No strong rate/backoff policy.
   - Runtime artifacts already reached ~23.76 GB.

3. Error classification misses important cases:
   - live/upcoming
   - copyright-blocked
   - private/removed
   - age-restricted
   - expired cookies
   - provider rate-limited

4. Cookies exist at `09-Transcript-Service/secrets/youtube-cookies.txt`.
   - Contents were not read.
   - Must not be monetized-channel cookies.

### Proposed fixes

1. Restrict accepted hosts for Radar jobs:
   - `youtube.com`
   - `www.youtube.com`
   - `youtu.be`

2. Add DNS resolution denylist:
   - private
   - loopback
   - link-local
   - multicast
   - unspecified

3. Add download constraints:
   - max duration
   - max filesize
   - socket timeout
   - bounded retries/fragment retries
   - cleanup of `.part`/temporary leftovers

4. Improve yt-dlp classification:
   - `yt_dlp_live_pending`
   - `yt_dlp_copyright_blocked`
   - `yt_dlp_private_or_removed`
   - `yt_dlp_age_restricted`
   - `yt_dlp_rate_limited`
   - `yt_dlp_cookie_expired`

5. Add modern YouTube hardening only after safety/taxonomy:
   - latest/nightly `yt-dlp`
   - `yt-dlp-ejs`
   - Deno or Node runtime
   - PO token provider such as `bgutil-ytdlp-pot-provider`
   - optional `mweb` client testing
   - conservative rate limit and cooldown

### What this resolves

- Reduces SSRF/resource-exhaustion risk.
- Makes failures safer and more actionable.
- Improves chance of recovering bot-check/token-related failures.
- Prevents the service from blindly hammering YouTube.

## `01-Control-Panel`

### What it does

- Vanilla JS modules, no build step.
- Cloudflare Pages static frontend.
- `Prensa` view loads `radar` feature modules.
- `Prensa IA` view loads `ai-rescue` feature modules.

### Current UI behavior observed

Prensa:

- Shows `202/202 VIDEOS MONITOREADOS`.
- Shows `TRANSCRITO`, `GEO-BLOQUEADO`, and generic `ERROR` cards.

Prensa IA:

- Shows `0/0 CANDIDATOS`.
- Queue modal shows active processing, waiting, and retry backlog.

### Important risks

- Dynamic content is mostly escaped, which is good.
- AI Rescue rejection links are weaker than Radar link validation: explicit `http(s)` links can appear instead of being restricted to HTTPS YouTube.
- No visible Content Security Policy header in `_headers`.
- Current UI cannot display better labels until backend emits better taxonomy.

### Proposed fixes

1. After backend taxonomy is added, map status labels in one place:
   - `BOT CHECK`
   - `COPYRIGHT`
   - `LIVE PENDIENTE`
   - `TIMEOUT`
   - `SIN SUBTÍTULOS`
   - `VIDEO NO DISPONIBLE`

2. Use backend `retryable` to show:
   - waiting/retry state
   - terminal state
   - operator hints

3. Restrict AI Rescue links to HTTPS YouTube, matching Radar behavior.

4. Consider CSP after confirming current inline/template requirements.

### What this resolves

- Operators understand why a card failed.
- Prevents accidental unsafe links.
- Avoids misleading progress on terminal failures.

## External options evaluated

| Option | Solves | Does not solve | Fit |
|---|---|---|---|
| Latest/nightly `yt-dlp` | YouTube extractor changes | Geo/copyright/account reputation | Required baseline |
| `yt-dlp-ejs` + Deno/Node | JS/player challenge support | Geo/copyright | Strong |
| PO token provider | Some 403/bot/token failures | No guarantee; no geo/copyright | Worth testing |
| Cookies | Account-required/age/private cases | Account/IP risk | Only throwaway, never monetized account |
| Rate limit/backoff | Reduces bot/rate blocks | Geo/copyright | Mandatory |
| Residential/regional proxy | Geo and IP reputation separation | Cost/trust/risk | Good if isolated |
| Supadata / TranscriptAPI | Text/transcript fallback for Prensa IA | No direct control, provider cost | Strong candidate |
| RapidAPI audio provider | Partial audio fallback | Failed geo-block tests | Experimental only |
| Official YouTube Captions API | Own-channel captions | Not third-party captions without owner auth | Not useful here |

## Proposed implementation phases

### Phase 0 — No-code verification and safety decisions

What to do:

- Decide whether cookies/proxies/providers are allowed.
- Confirm no monetized-channel cookies will ever be used.
- Choose test video set from real failed IDs.

Resolves:

- Prevents accidental risky implementation.

### Phase 1 — Security hardening

Touch:

- `10-Api-Gateway/src/gateway.js`
- `10-Api-Gateway/test/gateway-security.test.js`
- `09-Transcript-Service/app/downloader.py`
- `09-Transcript-Service/tests/*`

Do:

- Reject protocol-relative upstream paths in gateway.
- Restrict Transcript Service URL hosts.
- Add DNS private-IP denylist.
- Add max duration/filesize/timeouts.

Resolves:

- Gateway SSRF/open-proxy risk.
- Transcript SSRF-ish URL gap.
- Large/unbounded media resource risk.

### Phase 2 — Error taxonomy and DB/API fields

Touch:

- `09-Transcript-Service/app/downloader.py`
- `09-Transcript-Service/app/models.py` if response shape needs expansion.
- `10-Channel-Monitor-Service/app/workers.py`
- `10-Channel-Monitor-Service/app/store.py`
- `10-Channel-Monitor-Service/app/main.py`
- Channel Monitor tests.

Do:

- Add normalized failure categories.
- Preserve provider/operation/retryability.
- Map Radar and AI Rescue failures into stable machine codes.

Resolves:

- Converts generic `ERROR` and `no-subtitles` into actionable states.
- Enables safe retry policy.

### Phase 3 — UI labels and operator hints

Touch:

- `01-Control-Panel/js/modules/features/radar/render.js`
- `01-Control-Panel/js/modules/features/radar/state.js` if normalization changes.
- `01-Control-Panel/js/modules/features/ai-rescue/state.js`
- `01-Control-Panel/js/modules/features/ai-rescue/render.js`
- relevant frontend checks/tests.

Do:

- Show labels based on backend `failure_code` / `reason_code`.
- Show `retryable` vs terminal.
- Restrict AI Rescue links to YouTube HTTPS.

Resolves:

- Better operational clarity in Prensa and Prensa IA.

### Phase 4 — YouTube access hardening experiments

Touch after approval:

- `09-Transcript-Service/app/settings.py`
- `09-Transcript-Service/app/downloader.py`
- maybe scripts/docs for `yt-dlp-ejs`/Deno/PO token provider setup.

Do:

- Test latest/nightly `yt-dlp`.
- Enable/validate EJS runtime support.
- Test `bgutil-ytdlp-pot-provider`.
- Test `mweb` extractor args.
- Add cooldown when bot-check appears.

Resolves:

- Potentially reduces bot-check/token failures.
- Does not solve geo/copyright by itself.

### Phase 5 — Provider layer for Prensa IA and audio fallback

Touch after measurements:

- `10-Channel-Monitor-Service/app/youtube_client.py`
- `10-Channel-Monitor-Service/app/workers.py`
- provider config/settings/tests.

Do:

- Add transcript provider abstraction.
- Test Supadata / TranscriptAPI on real failed IDs.
- Consider isolated audio provider or regional worker only for cases that need audio.

Resolves:

- Improves Prensa IA candidate pipeline.
- Avoids unnecessary audio downloads when text is enough.

## What not to do

- Do not use cookies from the monetized YouTube channel.
- Do not run aggressive retries against YouTube.
- Do not use cheap/random proxies without isolation and measurement.
- Do not attempt to bypass copyright blocks.
- Do not convert all Prensa IA failures to audio/Whisper automatically without cost/risk analysis.
- Do not touch `02-Video-Engine`; it is unrelated to this Prensa issue.

## Recommended immediate next step

Start with a formal SDD proposal for:

```text
prensa-youtube-access-hardening
```

Scope:

1. Gateway protocol-relative path fix.
2. Transcript Service URL/download guardrails.
3. Initial normalized error taxonomy.
4. No external providers yet.
5. No cookie/proxy changes yet.

This first slice is high-value and low-risk. It makes the system safer and gives us the observability needed to choose the right provider strategy later.
