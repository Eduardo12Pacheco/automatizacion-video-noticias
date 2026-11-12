# ADR 0008 — File-size exceptions above 600 lines

## Status

Accepted (2026-11-12).

## Context

The verification round asked for production files above 600 lines to be split
into cohesive modules, or kept at or below 800 lines with an explicit
justification. Several modules are large but tightly scoped: splitting them
further would create pass-through layers or force private runtime state into
public objects.

## Decision

Files above 800 lines were split:

- `packages/data/src/adapters/in-memory-repository.js` now delegates user,
  session and video-project methods to `in-memory-users.js`,
  `in-memory-video-projects.js` and `in-memory-shared.js`.
- `services/channel-monitor/app/workers.py` moved retention cleanup into
  `app/retention.py`.
- `services/renderer/src/remotion/Composition.tsx` moved the newspaper scene to
  `newspaper-scene.tsx` and the motion preset resolver to `motion-range.ts`.

The remaining production files between 600 and 800 lines stay unsplit:

| File | Lines | Why keeping it together is cohesive |
|---|---|---|
| `services/channel-monitor/app/workers.py` | 795 | Worker classes share the store/lifecycle contracts and helper predicates; splitting one class at a time created import cycles before retention was moved out. |
| `services/approval-editor/server.js` | 786 | One HTTP request/response state machine over the same snapshot store; the routes and persistence helpers are only meaningful together. |
| `services/channel-monitor/app/main.py` | 755 | FastAPI app factory and the route surface; splitting routes would scatter one dependency graph. |
| `apps/panel/js/modules/features/video-projects/composition/composition-renderer.js` | 738 | One browser composition lifecycle: DOM, media sync, overlays and timeline callbacks must stay in lockstep. |
| `services/channel-monitor/app/youtube_client.py` | 729 | Metadata and subtitle parsing from one upstream API, with shared error taxonomy. |
| `packages/data/src/adapters/in-memory-repository.js` | 708 | Repository core (news, scripts, publish jobs) after the user/video mixins were extracted; the remaining methods share the same maps and transaction ordering. |
| `services/subtitles/subtitles_service/api/routes/subtitles.py` | 700 | One route module over one session store; the handlers share request validation and artifact naming. |
| `services/renderer/src/remotion/Composition.tsx` | 651 | The Remotion composition tree; splitting the scene graph would obscure the layering order. |
| `services/renderer/scripts/lib/render/video-engine-render-adapter.js` | 615 | Renderer-local asset localization + render command; it is the renderer's single render pipeline. |
| `apps/api/src/gateway-server.js` | 611 | The HTTP server composition and request lifecycle; the gateway modules it calls are already separate files. |
| `apps/panel/js/modules/features/subtitles/controller/table-editor.js` | 607 | One editable table with shared focus/selection/clipboard state. |

## Consequences

The 600-line target is documented rather than silently ignored. Any file that
grows above 800 lines must be split before the next verification round.
