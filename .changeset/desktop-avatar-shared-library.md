---
"desktop-avatar": patch
---

Use the shared Female Avatar 1/2 model and animation libraries from agent-avatars. Separate model loading/resource ownership from animation playback, discard stale loads, preserve animation phase across aliases, honor one-shot and reduced-motion behavior, and improve transparent-stage lighting. Distribute only the two bundled GLB libraries. Remove legacy/custom/packed loaders, their dependencies and old build tooling. Existing custom selections now fall back to Female Avatar 1; choose either bundled avatar in Settings. Rebuild the native client for the simplified bootstrap contract. Separate developer tools, HITL, window/dock and Rust module ownership; load chart code on demand.
