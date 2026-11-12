# newsroom-media

One yt-dlp integration for the Python services. The ASR worker downloads media
and the channel monitor fetches subtitles through the same argument builders,
URL guard and process runner, so failure classification and guardrails cannot
drift between services.

The Node `MediaDownloadPort` adapter does not spawn yt-dlp itself: it calls
`POST /api/radar/download` on the ASR worker, which uses this package.
