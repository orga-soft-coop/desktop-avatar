# SYNTRA Assistant

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
routePrompt(text)  ──→  API-first classifier
    │
    ├─ clear smalltalk      → LM Studio (local LLM, SSE streaming)
    └─ non-casual prompts   → SYNTRA Assistant backend API (create + SSE stream)
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

### Routing Policy (API-first)

- Default behavior is API-first: non-casual prompts are sent to the SYNTRA Assistant backend API.
- Local LM Studio chat is reserved for clear smalltalk/greeting prompts.
- If backend request creation returns an explicit unsupported/no-match routing error (for example no capable active agent), the client falls back once to local chat and reuses the existing placeholder message.
- Technical backend failures (timeout/network/5xx) do not auto-fallback; the error is shown to the user.

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
    router.ts                Prompt routing (API-first + local smalltalk exception)
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

**`router.ts`** — API-first prompt classification. Casual phrases (hallo, witz, who are you, etc.) stay local; all other prompts route to backend paths (`backendBusiness` or `backendReview`).

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

The app supports two avatar manifest styles:

- **Legacy VRM flow** (`vrmUrl` + external animation files)
- **Packed GLB flow** (`modelUrl` + clip-name mapping)

Assets can be absolute file paths, manifest-relative paths, or HTTPS URLs.

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

Packed GLB example:

```json
{
  "displayName": "Female Avatar 1",
  "modelUrl": "./sample-assets/female_avatar_1_packed.glb",
  "animationMapping": {
    "idle": "idle",
    "walking": "walking",
    "working": "thinking",
    "communicating": "communicating",
    "coffee-break": "coffee-break",
    "at-phone": "at-phone",
    "teleport-out": "teleport-out",
    "teleport-in": "teleport-in",
    "talking": "talking"
  }
}
```

Runtime fallbacks:
- `speaking` -> `talking` -> `communicating` -> `idle`
- `thinking/transcribing` -> `thinking` -> `working` -> `idle`

DevTools now show avatar runtime diagnostics:
- active asset kind (`legacy-vrm` or `packed-glb`)
- currently selected clip name
- resolved runtime mapping (`state -> clip`)

Supported formats:
- Legacy: `.vrm` (avatar), `.vrma` or `.fbx` clips
- Packed: `.glb` (mesh + rig + clips in one file)

Samples:
- `public/sample-avatar-manifest.json` (legacy)
- `public/sample-avatar-packed-manifest.json` (packed template)

### Avatar Build Pipeline (`semi|full`)

Build one packed GLB from `mesh.glb + base.fbx + clips/*.fbx`:

```bash
pnpm --dir desktop-avatar avatar:validate \
  --mode semi \
  --clips-dir /abs/path/clips
```

CI/automation friendly output:

```bash
pnpm --dir desktop-avatar avatar:validate \
  --mode semi \
  --clips-dir /abs/path/clips \
  --json
```

```bash
pnpm --dir desktop-avatar avatar:build \
  --mode semi \
  --mesh-glb /abs/path/female_avatar_1.glb \
  --base-fbx /abs/path/female_avatar_1_base.fbx \
  --clips-dir /abs/path/clips \
  --output-glb /abs/path/build/female_avatar_1.glb
```

For Tripo-rigged base FBX files, run:

```bash
pnpm --dir desktop-avatar avatar:build:tripo \
  --mode semi \
  --mesh-glb /abs/path/neutral_avatar_2.glb \
  --base-fbx /abs/path/neutral_avatar_2_base.fbx \
  --clips-dir /abs/path/clips \
  --output-glb /abs/path/build/neutral_avatar_2.glb
```

Use `--mode full` for final export.  
Optional in `full` mode: `--desktop-target` and `--studio-target` to copy the generated GLB to separate runtime paths.  
The build narrows unusually wide lower-body rest stance automatically and keeps capped vertical hips motion on a shared clip baseline so walking/working feet stay grounded.
Details: `tools/avatar-build/README.md`.

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `COMM_OFFICER_BASE_URL` | For business queries | — | Backend API URL |
| `COMM_OFFICER_TOKEN` | For business queries | — | Bearer token |
| `OPENAI_API_KEY` | For voice I/O | — | Speech transcription + OpenAI TTS |
| `OPENAI_STT_MODEL` | No | `gpt-4o-mini-transcribe` | STT model |
| `TTS_PROVIDER` | No | `auto` | TTS backend: `auto`, `local`, `fish`, `openai`, `system` |
| `OPENAI_TTS_ENABLED` | No | `true` | Use OpenAI TTS (fallback to system `say` on error) |
| `OPENAI_TTS_MODEL` | No | `gpt-4o-mini-tts` | OpenAI TTS model |
| `OPENAI_TTS_VOICE` | No | `onyx` | Default OpenAI TTS voice |
| `OPENAI_TTS_VOICES` | No | `OPENAI_TTS_VOICE` | Comma-separated voice options shown in DevTools |
| `LOCAL_TTS_URL` | For local TTS provider | — | Local HTTP endpoint for TTS. Runtime first tries the exact URL, then fallback candidates (for base URLs also `/v1` and `/v1/audio/speech`). |
| `LOCAL_TTS_API_KEY` | No | — | Optional bearer token for local TTS endpoint |
| `LOCAL_TTS_MODEL` | No | `kokoro` | Local TTS model name sent to `LOCAL_TTS_URL` |
| `LOCAL_TTS_VOICE` | No | `de_male` | Default local TTS voice |
| `LOCAL_TTS_VOICES` | No | `LOCAL_TTS_VOICE` | Comma-separated local voices shown in DevTools |
| `LOCAL_TTS_REQUEST_FORMAT` | No | `openai` | Request mapper preset: `openai` (`model`,`voice`,`input`) or `fish` (`text`,`speaker`,`model`) |
| `LOCAL_TTS_REQUEST_TEMPLATE` | No | preset from `LOCAL_TTS_REQUEST_FORMAT` | Optional JSON template with placeholders `{{model}}`, `{{voice}}`, `{{input}}` for arbitrary TTS APIs |
| `LOCAL_TTS_RESPONSE_BASE64_PATH` | No | auto-detect | Dot-path for JSON base64 audio payload (for non-binary TTS responses), e.g. `data.audio` |
| `LOCAL_TTS_HEADERS` | No | `{}` | Optional JSON headers map for local TTS requests |
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
pnpm test
```

| Test file | Coverage |
|-----------|----------|
| `router.test.ts` | Prompt routing for German/English business, casual, and review keywords |
| `contracts.test.ts` | BusinessCardPayload type structure validation |
| `tauri.test.ts` | IPC mocking and fallback behavior outside Tauri runtime |
| `window-presets.test.ts` | Preset dimensions, validation, and defaults |
