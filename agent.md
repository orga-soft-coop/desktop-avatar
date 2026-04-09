# Agent Guide — DesktopAvatar

This file describes the intended behavior and responsibilities of AI agents (Claude Code or similar) working on this codebase.

## Agent Role

You are assisting with a Tauri + React desktop companion application. Your work may span frontend (TypeScript/React), backend (Rust/Tauri), 3D/avatar systems (Three.js/VRM), and AI integration (LLM routing, SSE streaming, speech I/O).

## Before Making Changes

1. **Read files before editing.** Never propose or apply changes to code you have not read.
2. **Understand the routing logic** in `src/lib/router.ts` before changing how prompts are classified.
3. **Check `src/lib/contracts.ts`** for existing types before introducing new ones.
4. **Check `src-tauri/src/main.rs`** when modifying Tauri commands — frontend and backend signatures must stay in sync.

## Development Workflow

```bash
pnpm install          # install deps first
pnpm test             # run tests before and after changes
pnpm tauri:dev        # full dev build (requires Rust toolchain)
pnpm build            # frontend-only build check
```

Always run `pnpm test` after changes to catch regressions. The test suite covers routing, contracts, and Tauri helpers.

## Code Conventions

- **TypeScript**: strict mode, prefer explicit types in `lib/contracts.ts`
- **React**: functional components only, hooks for state
- **Rust**: follow existing patterns in `main.rs`; add new Tauri commands with `#[tauri::command]`
- **Imports**: keep lib imports relative; avoid barrel re-exports
- **No new files** unless clearly necessary — prefer extending existing modules

## Areas of High Sensitivity

| Area | File | Risk |
|---|---|---|
| SSE stream parsing | `src-tauri/src/main.rs` | Malformed JSON can break streaming |
| Tauri IPC bridge | `src/lib/tauri.ts` | Signature mismatch causes silent failures |
| Prompt routing | `src/lib/router.ts` | Wrong classification degrades UX |
| Animation state machine | `src/lib/vrm-animation.ts` | Incorrect bone mapping breaks avatars |
| Audio recording | `src/hooks/useDesktopCompanion.ts` | MediaRecorder API is platform-sensitive |

## Adding Features

- **New LLM backend**: add routing keywords in `router.ts`, new Tauri command in `main.rs`, update `contracts.ts`
- **New animation**: add to avatar manifest schema in `contracts.ts`, load in `avatar-assets.ts`, trigger in `vrm-animation.ts`
- **New UI card**: model after `OrderSummaryCard.tsx`, add variant to `contracts.ts`
- **New env variable**: add to `.env.example` and document in `README.md`

## Security Considerations

- Never log or expose `COMM_OFFICER_TOKEN` or `OPENAI_API_KEY`
- Env variables are accessed via Vite's `import.meta.env` — do not expose to public bundle unnecessarily
- Tauri commands validate inputs on the Rust side before making external HTTP calls
- Avatar asset URLs support HTTPS but local file paths should be validated before use

## Testing

Tests live in `src/test/`. Add tests for:
- New routing keywords or routing logic changes
- New contract types or type guard functions
- New utility functions in `src/lib/`

Do not add tests for Tauri-specific runtime behavior (those require the full Tauri environment).

## Out of Scope

Do not make changes to:
- `public/sample-assets/` — these are binary assets, not source files
- `src-tauri/Cargo.lock` — only update via `cargo update` when explicitly needed
- Build output directories (`dist/`, `src-tauri/target/`)
