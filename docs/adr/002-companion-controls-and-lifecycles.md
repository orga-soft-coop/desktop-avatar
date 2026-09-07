# ADR 002: Companion controls and independent resource lifecycles

Status: accepted; version-2 asset integration supersedes earlier asset limitations in ADR 004; avatar compatibility and module ownership updated by ADR 003

## Decision

Expose ordinary preferences separately from developer diagnostics. Reuse the configured manifest plus the two bundled model libraries; store a validated device-local selection and show existing source previews. Do not invent a cross-device profile/catalog API.

Separate output stop from new-chat clearing. Preserve history and independent business widgets, invalidate the current output epoch, stop native speech, close request transport, and cancel a known conversation through the existing API. Late accepted stopped requests are cancelled without resuming the UI. Local stopped presentation does not assert remote cancellation or undo ERP actions. Pending clarification remains valid when only completed speech is stopped.

Keep request/HITL/window coordination together and give Radar, microphone/STT, and speech playback their own hooks. This follows actual resource ownership, without a generic resolver, service container or new state framework.

Use existing distinct authored listening/speaking clips. Keep bundled GLBs unchanged. Tie rendering to document/native visibility and reduced-motion state: animation uses continuous frames, static poses demand frames, hidden windows no frames.

## Alternatives and tradeoffs

Do not make users clear their conversation to silence output. Do not mute all future notifications or resolve HITL when stopping the current output. Do not use focus loss to pause an always-on-top companion. Avoid another live 3D preview per avatar in Settings; existing PNG previews show both choices without additional contexts.

Native visibility events require a rebuilt client. Browser component/render checks do not verify native window placement, authenticated ERP execution, packaged macOS behavior or energy savings. The current backend cancellation contract does not promise rollback of work already performed.

For Peek, preserve the close portrait and follow the canonical wave with a short camera pan and modest pullback, then return. A permanently distant camera loses the desired prominent character; altering shared animation geometry would diverge from Studio. Keep this cue local to stage framing, driven by current clip time rather than wall-clock timers or guessed semantic aliases. No camera cue for arbitrary custom clips or reduced motion.

The shared stage owns a single greeting per loaded runtime. This keeps preview/model changes consistent with app startup and avoids consuming a wall-clock timeout while loading or hidden. Evaluate the first pose before rendering and omit substitute loading geometry; retain typed load errors and the separate unauthenticated brand surface. The planned notepad listening gesture requires an authored asset and is deferred.
