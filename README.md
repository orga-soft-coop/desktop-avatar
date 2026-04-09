# Desktop Avatar

Cross-platform desktop companion that renders a 3D VRM avatar with voice and text chat. Integrates with a local LLM (LM Studio) for casual conversation and a Communication Officer backend for business data queries.

## Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri 2 (Rust) |
| Frontend | React 19, TypeScript, Vite |
| 3D avatar | Three.js, @react-three/fiber, @pixiv/three-vrm |
| State | Custom hook (`useDesktopCompanion`) |
| Testing | Vitest, @testing-library/react |

## Prerequisites

- macOS 14+
- Xcode Command Line Tools
- Node.js 22+
- pnpm
- Rust toolchain (stable)

## Setup

1. `pnpm install`
2. Copy `.env.example` to `.env` and fill in the required values (see Environment below).
3. Start LM Studio with an OpenAI-compatible server on `http://127.0.0.1:1234/v1`.
4. Start the Communication Officer backend (if using business queries).
5. `pnpm tauri:dev`

## Commands

```bash
pnpm install                # Install dependencies
pnpm dev                    # Vite dev server (127.0.0.1:1420)
pnpm build                  # TypeScript check + Vite production build
pnpm test                   # Run tests (Vitest)
pnpm test:watch             # Watch mode
pnpm tauri:dev              # Full Tauri dev build (Rust + frontend)
pnpm tauri:build            # Production macOS .app bundle
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests
```

## Architecture

### Overview

```
┌─────────────────────────────────────────────────┐
│                  Tauri Window                    │
│  transparent · borderless · always-on-top       │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │           SpeechBubble (top)              │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │         AvatarStage (full window)         │  │
│  │    Three.js Canvas · VRM · Animations     │  │
│  │    z-index: 1 (behind all UI)             │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │        bottom-stack (flex column)         │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  DataPanel (table / card / slider)  │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │  ChatPanel (input + actions + dev)  │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

The window is a transparent, frameless overlay. The 3D avatar fills the entire window and renders behind all UI elements. The bottom area stacks data panels and the chat bar in a flex column. A `ResizeObserver` measures the bottom stack and dynamically resizes the Tauri window to fit.

### Data Flow

```
User input (text or voice)
    │
    ├─ Voice → OpenAI STT → transcript
    │
    ▼
routePrompt(text)  ──→  keyword classifier
    │
    ├─ "localChat"       → LM Studio (local LLM, SSE streaming)
    ├─ "backendBusiness"  → Communication Officer backend (SSE)
    └─ "backendReview"    → Communication Officer backend (SSE)
    │
    ▼
SSE stream events → Tauri emits to frontend
    │
    ├─ delta     → accumulate response text → SpeechBubble
    ├─ final     → display text + optional card → DataPanel
    └─ error     → error state
    │
    ▼
TTS (macOS `say` command) → speaking animation
```

### Directory Structure

```
src/
  components/
    AvatarStage.tsx          3D VRM rendering + animation state machine
    ChatPanel.tsx            Chat input, action buttons, collapsible dev tools
    SpeechBubble.tsx         Floating status/response display
    DataPanelSlider.tsx      Carousel for multiple data components
    DataTable.tsx            Generic table + demo data
    KpiCard.tsx              KPI metrics card + demo data
    OrderSummaryCard.tsx     Business order summary card
  hooks/
    useDesktopCompanion.ts   Central state: chat, avatar, window, recording, TTS
  lib/
    contracts.ts             All TypeScript interfaces
    tauri.ts                 Tauri IPC bridge (invoke + listen wrappers)
    router.ts                Prompt routing (keyword → local/business/review)
    avatar-assets.ts         Asset resolution (file paths, relative, HTTPS → blob URLs)
    vrm-animation.ts         VRMA + FBX loading with Mixamo bone mapping
    window-presets.ts        Size presets (S/M/L) + localStorage persistence
  styles/
    app.css                  All styles (glassmorphic dark theme)
  test/                      Vitest unit tests

src-tauri/
  src/main.rs                Tauri commands, SSE parsing, HTTP clients, TTS, tray
  Cargo.toml                 Rust dependencies
  tauri.conf.json            Window config, permissions, bundle settings
  capabilities/default.json  Tauri permission grants
```

### Key Modules

**`useDesktopCompanion` hook** — Central state manager. Owns chat history, companion state machine, recording lifecycle, TTS toggling, window expansion, and size presets. Coordinates all Tauri IPC calls.

**`AvatarStage`** — Renders a Three.js Canvas filling the full window. Loads a VRM model and animation clips from a manifest. A `CameraController` component adjusts camera Z position based on canvas height so the avatar maintains consistent visual size when the window grows.

**Animation state machine:**

| CompanionState | Animation played |
|----------------|-----------------|
| idle | Random idle clip |
| listening | attention clip |
| transcribing | thinking clip |
| thinking | thinking clip |
| speaking | talking clip |

**`router.ts`** — Classifies user prompts into routes via keyword matching. Business terms (Bestellung, Kunde, Rechnung, etc.) route to the backend. Casual phrases (hallo, witz, explain) stay local. Operational terms (check, status, gestern) go to the review endpoint.

**`main.rs` (Rust)** — Tauri backend with commands for:
- Window management (resize, drag, expand/collapse, click-through)
- Chat streaming (local LLM + business backend, both via SSE)
- Speech transcription (OpenAI API)
- TTS (macOS `say` command)
- Asset loading (local files + remote URLs)
- System tray (show/hide, size presets, TTS toggle, always-on-top, API URL)

### Dynamic Window Sizing

The window height adapts to its content automatically:

1. A `ResizeObserver` on the `.bottom-stack` div measures actual rendered height.
2. The difference from the base preset height is computed.
3. `resizeWindow()` adjusts the Tauri window, growing downward.
4. The `CameraController` inside the Three.js Canvas detects the new canvas height and pushes the camera back proportionally (`z = 4.0 * (canvasHeight / 780)`), keeping the avatar at a constant visual size.

Opening the dev tools drawer, showing a data table, or toggling the demo slider all seamlessly grow the window and compensate the camera.

### Window Presets

| Preset | Collapsed | Expanded |
|--------|-----------|----------|
| S | 440 x 660 | 440 x 780 |
| M | 520 x 780 | 520 x 920 |
| L | 600 x 900 | 600 x 1060 |

Width stays constant between collapsed/expanded — only height grows. The window keeps its top-left position fixed and expands downward.

### Data Panel System

Data components render in a slider/carousel above the chat bar:

- **DataPanelSlider** — Wraps N children as slides with dot indicators and left/right arrows. Single slides hide pagination.
- **DataTable** — Generic typed table with configurable columns and render functions.
- **KpiCard** — 2x2 metric grid with labels, values, and change indicators.
- **OrderSummaryCard** — Business order display with badges and currency formatting.

When a backend response includes a `card` payload, the appropriate component renders. The slider is used when multiple components need to be displayed simultaneously.

### System Tray

The macOS menu bar tray provides:
- Show / Hide window
- Size submenu (Collapsed / Expanded)
- Toggle TTS
- Toggle Always on Top
- LLM URL display (click to copy)
- Quit

## Avatar Assets

The app loads a VRM avatar and animation clips from a JSON manifest. Assets can be absolute file paths, manifest-relative paths, or HTTPS URLs.

```json
{
  "displayName": "Mint",
  "license": "CC0",
  "vrmUrl": "./sample-assets/mint.vrm",
  "idleAnimationUrls": [
    "./sample-assets/warrior-idle.fbx",
    "./sample-assets/bored.fbx"
  ],
  "attentionAnimationUrl": "./sample-assets/looking.fbx",
  "thinkingAnimationUrl": "./sample-assets/bored.fbx",
  "talkingAnimationUrl": "./sample-assets/looking.fbx"
}
```

Supported formats: `.vrm` (avatar), `.vrma` (native VRM animation), `.fbx` (Mixamo — auto-mapped via bone table in `vrm-animation.ts`).

A working sample is included at `public/sample-avatar-manifest.json` with a CC0 avatar and FBX clips in `public/sample-assets/`.

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `COMM_OFFICER_BASE_URL` | For business queries | — | Backend API URL |
| `COMM_OFFICER_TOKEN` | For business queries | — | Bearer token |
| `OPENAI_API_KEY` | For voice input | — | Speech transcription |
| `OPENAI_STT_MODEL` | No | `gpt-4o-mini-transcribe` | STT model |
| `ENABLE_TTS` | No | `true` | Text-to-speech toggle |
| `AVATAR_ASSET_MANIFEST` | No | `public/sample-avatar-manifest.json` | Path to manifest JSON |
| `LOCAL_LLM_BASE_URL` | No | `http://127.0.0.1:1234/v1` | LM Studio URL |
| `LOCAL_LLM_MODEL` | No | `qwen/qwen3.5-35b-a3b` | Model name |
| `LOCAL_LLM_API_KEY` | No | — | API key for local LLM |
| `VITE_DEV_TOOLS` | No | `false` | Show dev tools in chat panel |

## Design

- Glassmorphic dark theme with `backdrop-filter: blur` and semi-transparent backgrounds
- Accent color: `#8de8d8` (turquoise)
- All buttons use inline SVG icons (no icon library dependency)
- Collapsed view shows a launcher bar; expanded adds input, actions, and optional dev tools
- Data components share the same dark glass aesthetic

## Testing

```bash
pnpm test          # 4 test suites
```

| Test file | Coverage |
|-----------|----------|
| `router.test.ts` | Prompt routing for German/English business, casual, and review keywords |
| `contracts.test.ts` | BusinessCardPayload type structure validation |
| `tauri.test.ts` | IPC mocking and fallback behavior outside Tauri runtime |
| `window-presets.test.ts` | Preset dimensions, validation, and defaults |
