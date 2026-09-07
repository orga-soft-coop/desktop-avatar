# SYNTRA Assistant — AGENTS.md

## Project Overview

Cross-platform desktop companion application that renders a GLB 3D avatar with voice and text chat capabilities. Every user interaction runs through the active Agent Studio tenant session; there is no local LLM or static-token fallback.
This directory is the existing Tauri DesktopAvatar app and the target client for DesktopAvatar features in this repository.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **3D/Avatar**: Three.js, @react-three/fiber
- **Desktop Shell**: Tauri 2 (Rust backend)
- **State**: React hooks
- **Testing**: Vitest, @testing-library/react

## Directory Structure

```
src/                        # React/TypeScript frontend
  components/               # UI components
    AvatarStage.tsx         # Bundled GLB rendering
    ChatPanel.tsx           # Chat UI
    SpeechBubble.tsx        # Status display
    OrderSummaryCard.tsx    # Business data card
  hooks/
    useDesktopCompanion.ts  # Main state management hook
  lib/
    contracts.ts            # TypeScript interfaces
    tauri.ts                # Tauri IPC bridge
    router.ts               # Prompt routing logic
    avatar-assets.ts        # Asset loading
    window-presets.ts       # Window size management
  test/                     # Unit tests
src-tauri/                  # Rust/Tauri backend
  src/main.rs               # Composition, shared config, auth and tray
  src/window.rs             # Geometry, persistence and Peek
  src/transport.rs          # Tenant-bound request/HITL/Radar commands and streams
  src/speech.rs             # Transcription sessions and TTS
  Cargo.toml
  tauri.conf.json
public/
  sample-avatar-manifest.json
  avatars/                  # Female Avatar 1/2 and matching GLB clips
```

## Common Commands

```bash
pnpm --ignore-workspace install # Install using this independent app lockfile
pnpm dev              # Vite dev server (127.0.0.1:1420)
pnpm build            # TypeScript + Vite build
pnpm test             # Run tests (Vitest)
pnpm test:watch       # Watch mode
pnpm tauri:dev        # Full Tauri dev build
pnpm tauri:build      # Production Tauri build
```

## Environment Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Purpose |
|---|---|
| `COMM_OFFICER_BASE_URL` | Agent Studio API origin; HTTPS is required outside loopback development |
| `COMM_OFFICER_CSRF_COOKIE_NAME` | Optional CSRF cookie-name override; default `agent_studio_csrf` |
| `OPENAI_API_KEY` | Speech transcription |
| `OPENAI_STT_MODEL` | STT model (default: gpt-4o-mini-transcribe) |
| `ENABLE_TTS` | Text-to-speech toggle |

## Key Architecture Patterns

- **Authentication**: React drives only the public Agent Studio login/session API through Tauri IPC. Rust owns the in-memory cookie jar, short-lived in-memory password handoff from `preauthenticate` to the canonical `complete` request, CSRF extraction, origin validation, session confirmation, and logout. The password is atomically removed on every `complete` outcome.
- **Routing**: `src/lib/router.ts` may classify intent for UX/diagnostics, but every prompt is submitted to `/v1/desktop-avatar/requests`; no result or error may fall back to a local LLM.
- **Streaming**: Server-Sent Events (SSE) come only from Agent Studio and are bound to the immutable local `contextId` plus Agent Studio session/tenant state.
- **HITL streaming**: A separate backend SSE stream feeds approval cards and batched announcements without coupling to request-scoped assistant streams. Closing an approval panel is local presentation state only; it must not resolve or remove the live decision or its pending indicator. Collapsing and reopening the avatar resets local HITL dismissals so every still-pending decision appears again.
- **Operator Radar**: `GET /v1/desktop-avatar/radar` and `/radar/stream` provide a read-only widget feed; the client uses `summary.topSignalId` for one actionable priority card and renders only the remaining signals as a queue. Stream/poll updates may open existing HITL context, render source/why/timeline detail fields, and apply local-only Snooze/Follow display preferences but must not approve/reject or execute business actions itself
- **Tauri IPC**: All backend calls go through `src/lib/tauri.ts` using Tauri commands
- **Clarification turns**: `NEEDS_CLARIFICATION` is an explicit waiting lifecycle. Chip, text, and voice answers must use `POST /v1/desktop-avatar/requests/:requestId/clarifications/:clarificationId/replies`; never model them as unrelated root requests.
- **Dataset results**: `dataset` widgets render the first result page and load opaque cursors through `GET /v1/desktop-avatar/requests/:requestId/results/:resultId/pages`.
- **Backend safety**: Business denials and backend failures are surfaced to the user and must not fall back to local execution. Backend-supplied poll/stream URLs must match the configured Agent Studio origin before session credentials are used.
- **Tenant safety**: Every request, HITL mutation, Radar read, poll, and stream start/stop requires `expectedContextId`. Logout, expiry, and re-login unmount tenant UI, abort streams, clear in-memory request state, and reject stale frames.
- **Login race safety**: Every awaited preauthentication, company/branch lookup, and completion result must still match the current local login generation. Company lookup results additionally match the latest company request so stale or out-of-order responses cannot reopen or overwrite tenant selection.
- **Avatar Assets**: Only the bundled Female Avatar 1 and 2 GLB libraries are supported. Fetch the two allowlisted manifests and assets from the embedded frontend origin. Keep `public/avatars` byte-identical to the owning `agent-avatars` runtime directories, with SHA-256 provenance. Author/retarget there and refresh complete copies together. Do not restore custom filesystem/HTTPS, packed GLB, VRM/FBX loaders or a parallel build pipeline.
- **Three.js ownership**: `useAvatarRuntime` accepts only its current manifest load; `avatar-runtime` owns imported scenes, mixers and materials through success/failure/unmount. `avatar-playback` owns transitions, loop policy and completion listeners. Keep model framing outside animated transforms. Never attach the skeleton scenes from separate animation GLBs or apply the library's already-baked root-height calibration twice.
- **Animation lifecycle**: Same-action selections preserve phase; outgoing actions stop after a 240 ms crossfade. Library loop flags govern one-shots; forced exit callbacks use the requested semantic alias. Reduced motion keeps static poses while completing one-shot lifecycles. Resume deltas are bounded.
- **Animation State**: Avatar transitions between idle/listening/thinking/speaking states
- **TTS**: Uses macOS `say` command natively via Tauri

## Avatar Asset Manifest

`public/sample-avatar-manifest.json` and `public/sample-avatar-2-manifest.json` select `/avatars/female_avatar_1/manifest.json` and `/avatars/female_avatar_2/manifest.json` through `bundled-avatars.ts`. Each version-2 runtime manifest contains `avatar`, a relative GLB `model`, and named GLB `clips` with Boolean `loop` flags. Preserve source metadata and matching 45-bone model/clip sets. Parse the version-2 prop catalog and clip hand attachments; validate finite transforms and prop references. Frame only the figure and keep resource cleanup for attached and detached props idempotent.

## Notes

- Minimum macOS version: 14.0
- Window is transparent, borderless, always-on-top
- The native window is visible on startup. Before a tenant session is confirmed, keep the neutral closed/peek circle with the bundled OrgaSoft app icon visible in a 520 x 600 login-sized window and allow only the dedicated, opaque login-step overlay; do not mount `AvatarStage`, load a user avatar, start tenant business UI, or generalize overlays in peek mode.
- Brand the login surface as `SYNTRA · Desktop Agent`. Its non-interactive surface remains draggable through the existing native window-drag command; form controls must not initiate a window drag.
- After credentials are accepted, show company and branch together as reusable searchable comboboxes in one tenant-selection step. Keep the existing sequential Agent Studio API calls, full keyboard/listbox semantics, a reduced-motion-safe forward transition, and the authenticated tenant badge plus logout action pointer-interactive despite the click-through shell. Do not import frontend-v2 shadcn files across package boundaries just for these controls.
- Collapsed: 520×780, Expanded: 720×920
- Agent-specific visual modes (Warehouse, Purchase, Production, Ops Manager) are future work. Current animation remains status-based (`attention`, `thinking`, `talking`, `idle`) even when Radar signals include `agentName`, `agentRole`, or `agentAvatarId`.

## Companion UI and lifecycle boundaries

- Keep user preferences in `CompanionSettings` and developer diagnostics separate. Avatar preference is device-local, validated against the two bundled choices, and resolved only after login. Missing/invalid/obsolete preferences fall back to Female Avatar 1; preserve the bundled frontend asset-loading path.
- Preserve transcript reading position while streaming. Stop output retains history and HITL; `outputStopped` is local presentation, never proof of server rollback. Capture conversation epochs before awaits and reject late results/errors; use the existing tenant-bound cancellation API for known stopped conversations.
- `useOperatorRadar` owns Radar resources, `useVoiceCapture` owns recorder/STT resources, and `useSpeechOutput` owns pending/suppressed speech IDs. Keep tenant context captured through cleanup. Do not reintroduce these resource lifecycles into UI components.
- Pause hidden canvas rendering and use demand frames for reduced motion, invalidating after pose/model/camera changes. Emit native visibility after successful show/hide, never treat blur as hidden.

- Keep Peek large at rest. Its brief wave camera cue belongs in stage camera framing, follows the active authored clip time, and must not mutate model/animation assets. Respect reduced motion, preserve expanded framing, and verify both bundled hands inside the circular mask.

- Own the once-per-model-load greeting in the shared stage, not App or preview timers. Reuse the authored wave and prepare its initial pose before display; render no temporary loading orb. Preserve forced selection, missing-clip fallback, reduced motion and visible errors. Listening maps to the authored `taking-notes` clip with notebook and pen. Attach props through the manifest hand transforms using Three.js bone-name sanitization. Preserve the source-authored side-on writing grip; correct hand/pen alignment in the shared authoring source, not through runtime wrist offsets. Remove previous props on action change and dispose them with their runtime, including partial failures.

- Keep chat rendering and developer controls in `ChatPanel` / `CompanionDeveloperTools`. Keep disclosure state stable across collapse/reopen.
- `useCompanionWindow` owns native mode/size/tray subscriptions; `useWidgetDockLayout` owns DOM measurement and dock anchoring. `useHitlDecisions` owns HITL streams, notification batching and actions. Keep request/clarification/cancellation coordination together, preserving captured tenant context.
- Load `WidgetAreaChart` dynamically; no static Recharts import in the app's initial graph. Native window, transport and speech code belongs in the corresponding Rust modules, with existing command names and tenant guards preserved.
