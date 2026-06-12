# desktop-avatar spec

## Purpose

`desktop-avatar` is the Tauri desktop shell and React UI for the SYNTRA Assistant companion.
It provides:

- voice/text input
- streamed assistant output
- streamed HITL decision notifications and approval cards
- avatar runtime state transitions
- local desktop integrations (windowing, tray, TTS, STT)

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

### Safety rules

- `SIMULATION` approvals/rejections may be submitted inline from the card.
- `EXECUTION` decisions require explicit user confirmation or opening the HITL view before mutation.
- Reject and request-more-info actions require a non-empty reason/message.

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
