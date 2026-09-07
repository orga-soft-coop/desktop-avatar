# ADR 003: Two bundled GLB avatars and focused runtime modules

Status: accepted; version-2 asset integration supersedes earlier asset limitations in ADR 004

## Decision

The user explicitly limits desktop distribution to the new Female Avatar 1 and 2 libraries shared with Studio. Remove VRM/VRMA/FBX, custom filesystem/HTTPS and packed-GLB loading, their dependencies, native file command, bootstrap manifest field, environment selector, packed sample and old build pipeline. Keep both source libraries and matching GLB clips byte-identical. Production CSP allows same-origin asset fetches through `connect-src 'self'`; business connections still use native IPC. Device selection defaults to Female Avatar 1, including obsolete `configured` values. Authoring stays in `agent-avatars`.

This supersedes ADR 001's legacy compatibility and ADR 002's configured-avatar fallback. The renderer's initial pose, greeting, Peek camera and resource ownership remain as documented there.

Extract developer controls, native window state, DOM dock measurement and the independent HITL feed into existing-prop hooks/components. Keep request, clarification and cancellation together. Preserve immutable tenant ownership, cleanup and native IPC names while moving window, transport and speech implementations into Rust modules. Chart code loads only for chart widgets.

## Alternatives and consequences

Retaining generic legacy format/asset loaders would maintain an unused second product path and dependencies. Converting or rebuilding GLBs here would duplicate the owning project's authoring pipeline. No new global store, resolver framework, backend catalog or user-profile API is introduced.

Rebuild the native client because obsolete avatar bootstrap/IPC fields were removed. Existing environment manifest settings are ignored; use Settings to select either bundled avatar. Native process/build evidence does not substitute for visual checks in the native window; browser previews do not exercise authenticated business actions. The notepad listening asset remains deferred.

The bundled distribution is pinned to the recorded version-1 export. The source project produced a separate version-2 hand/prop library during this refactor; adopting its extra clips, attachments and notepad presentation is a separate integration, not silently substituted into this verified snapshot.

## Verification

The refactor passed 184 frontend tests and 32 native tests. Follow-up hook/IPC checks passed 53 tests after cleanup. TypeScript and the production Vite build pass; the chart module is a separate approximately 383 KB chunk. Both figures' greeting, visible hand and close resting portrait were inspected in the browser. Both complete ten-GLB libraries load successfully under the production CSP. Surviving Rust function bodies are unchanged by extraction; only avatar bootstrap/file-loading behavior changes. Documentation API generation, checks, lint and Fumadocs validation pass. Direct Mode uses self-review. Native startup is checked as a process/build; native visual/authenticated business acceptance is not asserted.
