# SYNTRA Assistant — CLAUDE.md

## Project Overview

Cross-platform desktop companion application that renders a VRM 3D avatar with voice and text chat capabilities. Every interaction uses the active Agent Studio tenant session; no local LLM or static-token fallback exists.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **3D/Avatar**: Three.js, @react-three/fiber, @react-three/drei, @pixiv/three-vrm
- **Desktop Shell**: Tauri 2 (Rust backend)
- **State**: Zustand + React hooks
- **Testing**: Vitest, @testing-library/react

## Directory Structure

```
src/                        # React/TypeScript frontend
  components/               # UI components
    AvatarStage.tsx         # 3D VRM rendering
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
    vrm-animation.ts        # Animation playback (Mixamo mapping)
    window-presets.ts       # Window size management
  test/                     # Unit tests
src-tauri/                  # Rust/Tauri backend
  src/main.rs               # Tauri command handlers
  Cargo.toml
  tauri.conf.json
public/
  sample-avatar-manifest.json
  sample-assets/            # Sample VRM + FBX animations
```

## Common Commands

```bash
pnpm install          # Install dependencies
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
| `COMM_OFFICER_CSRF_COOKIE_NAME` | Optional Agent Studio CSRF cookie-name override |
| `OPENAI_API_KEY` | Speech transcription |
| `OPENAI_STT_MODEL` | STT model (default: gpt-4o-mini-transcribe) |
| `ENABLE_TTS` | Text-to-speech toggle |
| `AVATAR_ASSET_MANIFEST` | Path to avatar manifest JSON |

## Key Architecture Patterns

- **Authentication**: React uses only Agent Studio's public login/session API through Tauri IPC. Rust owns cookies, CSRF, origin validation, and the short-lived in-memory password handoff required by `complete`; it never implements its own auth semantics.
- **Routing**: `src/lib/router.ts` may classify intent for UX/diagnostics, but every prompt is sent through Agent Studio; errors never fall back to a local LLM
- **Streaming**: Server-Sent Events (SSE) come only from Agent Studio and are guarded by the active immutable tenant context
- **Tauri IPC**: All backend calls go through `src/lib/tauri.ts` using Tauri commands
- **Tenant safety**: Logout, expiry, and re-login abort streams, clear in-memory business state, stop speech/transcription work, and reject stale frames before they reach React
- **Avatar Assets**: Manifest-based system supporting local paths, relative paths, and HTTPS URLs
- **Animation State**: Avatar transitions between idle/listening/thinking/speaking states
- **TTS**: Uses macOS `say` command natively via Tauri

## Avatar Asset Manifest

```json
{
  "displayName": "Name",
  "vrmUrl": "path/to/avatar.vrm",
  "idleAnimationUrls": ["idle.vrma"],
  "attentionAnimationUrl": "attention.fbx",
  "thinkingAnimationUrl": "thinking.vrma",
  "talkingAnimationUrl": "talking.vrma"
}
```

## Notes

- Minimum macOS version: 14.0
- Window is transparent, borderless, always-on-top
- Collapsed: 520×780, Expanded: 720×920
- Supports `.fbx` (Mixamo) and `.vrma` animation formats
