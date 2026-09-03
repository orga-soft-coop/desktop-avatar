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

## Request Conversation, Clarification, and Dataset Contract

Business requests are append-only server turns. `POST /v1/desktop-avatar/requests` returns the request identifiers/URLs and may return `conversationId` while older deployments remain supported.

When a turn reaches `NEEDS_CLARIFICATION`, the client enters `awaiting-clarification` and keeps the clarification visible. A reply-capable widget has:

- `type: "clarification"`
- `clarificationId`, `conversationId`, and optional `expiresAt`
- `title`, `question`, and `suggestions[]`

Chip, typed, and transcribed voice answers all call `POST /v1/desktop-avatar/requests/:requestId/clarifications/:clarificationId/replies` with `{ clientRequestId, answer }`. The `202` response has the same shape as request creation and starts a new immutable child-turn stream. Legacy clarification widgets without IDs remain renderable but cannot resume a server conversation. Expired or already answered chips are disabled. Starting a new chat clears local state immediately and best-effort calls `POST /v1/desktop-avatar/conversations/:conversationId/cancel` for the captured server conversation.

Relational results use a `dataset` widget with `resultId`, `locale`, `rowCount`, typed columns, rows, and an optional opaque `cursor`. Additional pages are loaded with `GET /v1/desktop-avatar/requests/:requestId/results/:resultId/pages?cursor=...`; the client appends rows and uses only the returned `nextCursor` for continuation. Lookup labels are display metadata and do not replace raw row values in the transport contract.

### Routing and transport safety

- Every prompt uses the Agent Studio DesktopAvatar API. Any prompt containing business intent keeps its business classification even if it also contains a greeting.
- A business denial, authorization failure, no-agent result, timeout, or other backend error is shown as-is and never handed to local execution.
- Tauri validates backend-supplied stream and polling URLs against the configured Agent Studio origin before using the active session credentials.
- Request IDs, result IDs, clarification IDs, conversations, and cursors are URL-encoded as path/query data.

## Tenant authentication

- A tenant is exactly the server-derived `tenantId` for one `{companyId, branchId}` pair.
- Interactive DesktopAvatar authentication uses only Agent Studio API endpoints: `preauthenticate`, `companies`, `branches`, `complete`, `session`, and `logout`.
- The Tauri/Rust process owns an in-memory cookie jar and the CSRF double-submit contract. React clears the submitted password immediately. Because Agent Studio's canonical `complete` request also requires the password, the native broker retains it only in process memory between `preauthenticate` and `complete`, atomically takes it for `complete`, and clears it on every outcome. It is never persisted, logged, or returned to React.
- The native broker parses the login-flow `expiresAt`, rejects invalid or past values, and clears the pending password plus login cookies at expiry even without another user action.
- A successful `complete` is confirmed with `GET /v1/auth/session` before an immutable `DesktopAvatarTenantSession` is activated.
- Delayed preauthentication, company/branch lookup, and completion responses are accepted only while their local login generation is current. Company lookups also use a monotonically increasing request token so an older response cannot overwrite a newer dropdown selection.
- Regular tenant switching is logout plus a complete `COMPANY_BRANCH` re-login. Body, query, or caller-defined headers cannot select or override a tenant.
- Static global tokens and tenant service tokens are not supported by the interactive desktop client.

### DesktopAvatarTenantSession

- `contextId` is a fresh local UUID for one confirmed Agent Studio session activation.
- `publicSession` contains the public user, selected tenant, accessible tenants, administrable tenant ids, and expiry only.
- `localEpoch` invalidates in-flight work atomically on preauthentication, logout, expiry, or re-login.
- Each Agent Studio operation captures the validated session epoch and its cookie transport under the broker transition guard. Replacing the active session may invalidate that operation but may never redirect it into the replacement tenant's cookie jar.
- Stream start, replacement, task spawn, and handle registration complete under that transition guard. Every registered stream has a unique owner token; stale cleanup may remove only that owner and cannot unregister a replacement stream for the same request or subscription key.
- Every DesktopAvatar request/poll, HITL mutation, Radar call, and stream start/stop requires the current `expectedContextId` at the Tauri boundary.
- Every SSE frame is checked against `contextId + localEpoch` immediately before emit; emitted payloads carry `contextId`, and React drops mismatches even when business/request ids are identical across tenants.
- React captures `contextId` at the start of delayed text and microphone interactions and rechecks it after awaited UI or media work, before any Agent Studio or transcription command.

### Login and reset behavior

- The login gate replaces all business UI until `GET /v1/auth/session` or a completed login yields a confirmed session.
- The login surface is branded `SYNTRA · Desktop Agent`; user-facing authentication copy uses SYNTRA rather than the internal Agent Studio service name.
- Credentials are the first screen. After successful preauthentication, company and branch appear together in a second-screen form using reusable searchable comboboxes that match the SYNTRA Studio login pattern. Each combobox supports text filtering, Arrow Up/Down, Enter, Escape, and listbox semantics without introducing a second UI dependency stack. Choosing a company still loads only its authorized branches through the existing API before the final `complete` request; the UI does not infer or override tenant access.
- The forward transition into tenant selection is subtle and disabled when reduced motion is requested.
- Pointer-dragging the circle, heading area, or other non-interactive login surface moves the native window. Inputs, labels, buttons, links, selects, and text areas retain their normal interaction behavior.
- The native window is visible at process startup. While unauthenticated, it stays visually in the neutral closed/peek-circle state with the bundled OrgaSoft app icon and opens a 520 x 600 login-sized window containing the dedicated opaque login overlay for credentials, company, branch, and recovery steps. This is the only overlay allowed before the authenticated app mounts; it does not enable normal content/widget overlays in peek mode. `AvatarStage` and the VRM figure remain unmounted until the tenant session is confirmed.
- The neutral pre-auth circle is not an avatar preference or identity. Future user-selectable avatars must be resolved only after authentication; a device-local preference may be used as a local fallback, while cross-device user identity belongs to a server-owned user profile contract.
- The active company and branch are visible in the expanded app.
- The active-tenant badge and its logout button remain pointer-interactive inside the otherwise click-through avatar shell.
- Logout immediately unmounts tenant UI, aborts all request/Radar/HITL streams, clears conversation, HITL/Radar, TTS, transcription, and polling state, then invalidates cookies.
- Session expiry/revocation returns to the login gate; no offline queue or local-response fallback exists.
- During initial bootstrap or recovery, a transient `GET /v1/auth/session` transport error keeps the tenant UI closed and exposes retry/logout without starting a second login flow. A transient verification failure does not by itself invalidate an already confirmed, locally unexpired tenant session. Only a confirmed missing, invalid, or expired session returns to credentials.
- `localStorage` is limited to tenant-neutral UI preferences. Conversation, Radar/HITL data, attachments, uploads, and offline work are not persisted.
- Persisted frontend telemetry discards message content and stores only a normalized log level. Redacted logs and geometry-only window state live in the OS application-data directory with owner-only permissions, never in the repository.
- TTS child processes are spawned and registered atomically under the broker transition guard. Logout and session invalidation advance the TTS generation, cancel every registered child, wait for confirmed termination, clear transcription state and temporary audio, and reject provider fallback after the captured context becomes stale. App exit runs the same awaited drain; `kill_on_drop` is retained as the final child-process safety net.

### Error contract and permission matrix

- Rust returns structured Agent Studio errors with optional `status`, `code`, `message`, and `retryAfter`; credentials, cookie values, response bodies, and internal OCWS errors are never forwarded verbatim.
- Auth DTOs reject unknown fields. Company and branch ids are canonical numeric strings, and session/login-flow expiry values must parse as RFC 3339 timestamps.
- Local guard failures use `AUTH_NOT_CONFIGURED`, `AUTH_INVALID_REQUEST`, `AUTH_CSRF_REQUIRED`, `AUTH_OCWS_UNAVAILABLE`, `AUTH_OCWS_INVALID_RESPONSE`, `DESKTOP_BACKEND_ORIGIN_MISMATCH`, or `DESKTOP_SESSION_CHANGED`.
- A missing/expired/revoked Agent Studio session closes the tenant UI. Network errors remain retryable user-visible failures and never activate offline/local execution.

| State | Allowed DesktopAvatar activity |
|---|---|
| Unauthenticated | `preauthenticate`; no business UI or data calls |
| Preauthenticated login flow | list allowed companies, list branches for a selected company, complete login, or restart login |
| Confirmed user session | DesktopAvatar request/poll/SSE, Radar, Office/API reads, and HITL actions only when Agent Studio authorizes them in the selected tenant |
| Expired/logged-out/stale context | no request, mutation, poll, or frame emit; full login is required |
| Headless/service scenario | outside this interactive client; if introduced later, it requires a separately documented tenant-bound service-token contract |

Global skill/category/input-contract/action catalogs remain governed by Agent Studio and are not made tenant-switchable by DesktopAvatar.

### Migration and release impact

- No persisted data migration is required because tenant data is not stored locally.
- Deployments must remove `COMM_OFFICER_TOKEN`, `COMM_OFFICER_TENANT_SERVICE_TOKEN`, `LOCAL_LLM_*`, and `ROUTING_MODE` from DesktopAvatar configuration and set `COMM_OFFICER_BASE_URL` instead.
- Existing users must complete one Agent Studio `COMPANY_BRANCH` login after upgrading; sessions are intentionally memory-only and are not restored after process restart unless Agent Studio's cookie contract later provides an approved secure persistence mechanism.
- Release notes must call out the removed local fallback, mandatory connectivity, full login gate, logout-only tenant switching, and stream/cache reset semantics.
- Release canaries must cover `Login tenant A → request/HITL/Radar → logout → Login tenant B` with colliding business identifiers and verify that old streams, speech, temporary audio, and local caches cannot affect tenant B.

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
- Closing one or all visible HITL approval panels hides those decisions only for the current expanded presentation. It does not approve, reject, resolve, or remove them from the live pending collection/count; a newly arriving distinct decision remains eligible to open normally. After the avatar is collapsed and expanded again, every still-pending HITL decision is shown again.

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
- The widget uses `summary.topSignalId` for one fully actionable "Jetzt wichtig" focus card, falling back to the first visible item when no matching id is available. The focused signal is not repeated in the remaining-signal queue.
- Detail, Snooze, Follow, completion-only, and HITL-context actions remain available on the focused signal and on eligible queued signals.
- Radar Snooze/Follow controls are local DesktopAvatar UI state only. Snooze hides non-critical signals from the local widget/count for 10 minutes; "Bei Abschluss melden" hides running signals locally until they return as completed/failed/blocked; Follow clears local hiding and marks the signal as watched. These controls are not server-side visibility or tenant/user access rules.
- Developer tools include Radar scenario widgets for Forecast running, Forecast completed, HITL open, Run failed, and Warehouse reorder checks.
- Polling/API failures render a non-blocking error widget only when the Radar widget is already open or explicitly opened.

### Audience and avatar-mode boundary

- Radar `audience` values are relevance metadata only in V1.
- User, manager, and tenant isolation is enforced by the active Agent Studio session; Radar `audience` remains display/relevance metadata and cannot expand permissions.
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
- `cargo test agent_studio::tests` in `src-tauri`
