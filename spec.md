# desktop-avatar spec

## Purpose

`desktop-avatar` is the Tauri desktop shell and React UI for the SYNTRA Assistant companion.
It provides:

- voice/text input
- compact conversation history in the expanded chat panel
- streamed assistant output
- streamed HITL decision notifications and approval cards
- Operator Radar widget streaming/polling and rendering
- avatar runtime state transitions
- local desktop integrations (windowing, tray, TTS, STT)

`desktop-avatar/` is the existing Tauri DesktopAvatar app and is the target client for DesktopAvatar features in this repository.

## HITL Middleware Contract

HITL notifications are provider-driven by the Agent Studio backend SSE stream.

- Frontend uses Tauri IPC commands:
  - `hitl_decision_stream_start`
  - `hitl_decision_stream_stop`
  - `hitl_decision_approve`
  - `hitl_decision_reject`
  - `hitl_request_more_info`
- Backend emits:
  - `hitl-decision-stream-event`
  - `hitl-decision-stream-lifecycle`
- Incoming `required` decision bursts are displayed as individual approval cards but announced as one short spoken/status update per burst.

### Safety rules

- `SIMULATION` approvals/rejections may be submitted inline from the card.
- `EXECUTION` decisions require explicit user confirmation or opening the HITL view before mutation.
- Reject and request-more-info actions require a non-empty reason/message.

## Operator Radar Contract

Operator Radar is a read-only DesktopAvatar widget feed.

- Frontend uses Tauri IPC command:
  - `desktop_avatar_radar_get`
  - `desktop_avatar_radar_stream_start`
  - `desktop_avatar_radar_stream_stop`
- Backend route:
  - `GET /v1/desktop-avatar/radar`
  - `GET /v1/desktop-avatar/radar/stream`
- UI payload:
  - local widget type `operatorRadar`
  - `summary`
  - `items[]`

### Radar rules

- Radar polling must not create agent runs.
- Radar polling must not call IWS.
- Radar polling and streaming update only the button indicator/count by default; they must not automatically open or focus the Radar widget.
- The Radar widget opens when the user explicitly clicks the Radar button and then behaves like a normal slider widget.
- The Radar stream emits `ready`, initial `snapshot`, subsequent `update`, and `error` events. Snapshot/update payloads reuse the normal Radar response shape so the widget does not implement separate delta logic.
- Polling remains as a fallback/safety net when the stream is unavailable or disconnected.
- Developer tools must provide demo entries for the Radar and HITL widgets so both can be tested without live backend events.
- Radar UI must not approve/reject HITL decisions directly.
- HITL radar signals may open the existing HITL context/approval card.
- Runtime radar signals are context-only, including active, recently completed, and failed DesktopAvatar-triggered agent activity.
- Radar signals may include optional `source`, `why`, and `timeline` fields; the widget uses them for an expandable detail card, activity timeline, and "Warum sehe ich das?" explanation.
- Radar Snooze/Follow controls are local DesktopAvatar UI state only. Snooze hides non-critical signals from the local widget/count for 10 minutes; "Bei Abschluss melden" hides running signals locally until they return as completed/failed/blocked; Follow clears local hiding and marks the signal as watched. These controls are not server-side visibility or tenant/user access rules.
- Developer tools include Radar scenario widgets for Forecast running, Forecast completed, HITL open, Run failed, and Warehouse reorder checks.
- Polling/API failures render a non-blocking error widget only when the Radar widget is already open or explicitly opened.

### Audience and avatar-mode boundary

- Radar `audience` values are relevance metadata only in V1.
- Real user, manager, and tenant isolation will be implemented later in Agent Studio.
- Agent-specific visual modes for Warehouse, Purchase, Production, and Ops Manager are future work.
- V1 animation remains status-based: `attention`, `thinking`, `talking`, `idle`.

## STT Middleware Contract

Speech transcription is provider-driven and session-based.

- Frontend uses Tauri IPC commands:
  - `transcription_provider_get`
  - `transcription_provider_set`
  - `transcription_session_start`
  - `transcription_session_append_audio`
  - `transcription_session_commit_turn`
  - `transcription_session_stop`
- Backend emits:
  - `transcription-stream-event`
  - `transcription-provider-changed`

### Providers

Supported provider IDs:

- `openai-realtime`
- `openai-file-fallback`

Selection behavior:

- Active provider is mutable at runtime (tray + frontend devtools).
- Default provider comes from `TRANSCRIPTION_PROVIDER_DEFAULT` (default: `openai-realtime`).
- Fallback provider comes from `TRANSCRIPTION_PROVIDER_FALLBACK`; if unset and default is realtime, fallback defaults to `openai-file-fallback`.

### Audio format rules

- Realtime provider expects PCM16 mono at 24kHz (`audio/pcm`).
- Frontend converts recorder output to PCM when realtime provider is selected.
- File fallback accepts file-compatible audio (`webm`, `mp4`, `wav`, etc.).
- If fallback receives PCM, backend wraps it to WAV before calling file transcription API.

### Session rules

- `sessionId` is required and stable for one recording turn.
- Appended chunks must keep the same mime type per session turn.
- Session buffer limit is `24 MiB`.
- `commit_turn` clears buffered audio for that session after snapshotting.

### Event semantics

- `session_ready`: session created and ready to accept audio.
- `speech_started` / `speech_stopped`: client-side recording phase boundaries.
- `partial`: incremental transcript updates (provider-dependent).
- `final`: final transcript text; includes `provider` and `fallbackUsed`.
- `error`: provider/turn level transcription failure details.

## Environment variables

- `OPENAI_API_KEY`
- `OPENAI_STT_MODEL` (file transcription model)
- `OPENAI_REALTIME_STT_MODEL` (realtime transcription model)
- `TRANSCRIPTION_PROVIDER_DEFAULT`
- `TRANSCRIPTION_PROVIDER_FALLBACK`

## Verification baseline

- `pnpm test`
- `pnpm build`
- `cargo check` in `src-tauri`
