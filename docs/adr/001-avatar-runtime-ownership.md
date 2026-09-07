# ADR 001: Shared avatar assets and explicit rendering ownership

Status: accepted; version-2 asset integration supersedes earlier asset limitations in ADR 004; avatar compatibility and module ownership updated by ADR 003

## Decision
Consume the existing agent-avatars version-1 runtime manifest directly through one optional `animationLibraryUrl` field. Distribute the two complete per-avatar runtime directories unchanged and record their source hashes. Preserve the existing packed and VRM paths.

Separate async asset ownership, model framing and playback control. Keep normalized framing outside animated transforms, scope cleanup to the creating load, and dispose late results after replacement/unmount. Animation clips bind to the loaded figure's skeleton; never attach the separate clip scene. Stable action selection preserves phase and library loop flags govern one-shots.

## Alternatives
Do not recreate the figures procedurally or repack/retarget the shared clips for this client: that would create a second model authoring source. Do not import frontend-v2 components across repository boundaries. A live user-profile/model-catalog preference needs a separate server-owned contract and is outside this renderer refactor.

## Consequences
Model authoring remains in agent-avatars. Updating distribution copies is explicit and verifiable, without silently syncing user files. The native binary needs rebuilding for the added manifest field. Browser rendering verification is separate from native window and packaged-release verification.
