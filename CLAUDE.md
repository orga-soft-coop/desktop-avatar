# DesktopAvatar — CLAUDE.md

## Project Overview

Cross-platform desktop companion application that renders a VRM 3D avatar with voice and text chat capabilities. Integrates with local LLMs (LM Studio) and a Communication Officer backend for business data queries.

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
| `COMM_OFFICER_BASE_URL` | Business backend URL |
| `COMM_OFFICER_TOKEN` | Backend auth token |
| `OPENAI_API_KEY` | Speech transcription |
| `OPENAI_STT_MODEL` | STT model (default: gpt-4o-mini-transcribe) |
| `ENABLE_TTS` | Text-to-speech toggle |
| `AVATAR_ASSET_MANIFEST` | Path to avatar manifest JSON |
| `LOCAL_LLM_BASE_URL` | LM Studio URL (default: 127.0.0.1:1234/v1) |
| `LOCAL_LLM_MODEL` | Local model name |
| `ROUTING_MODE` | Routing strategy (e.g. desktop_assisted_hybrid) |

## Key Architecture Patterns

- **Routing**: `src/lib/router.ts` classifies prompts to local LLM or business backend via keyword matching
- **Streaming**: Server-Sent Events (SSE) for real-time response streaming from both backends
- **Tauri IPC**: All backend calls go through `src/lib/tauri.ts` using Tauri commands
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
