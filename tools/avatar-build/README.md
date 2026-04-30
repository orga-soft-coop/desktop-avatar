# Avatar Build Tool (`semi|full`)

This pipeline creates one packed GLB avatar from:

- visual mesh GLB (`--mesh-glb`)
- rigged base FBX (`--base-fbx`)
- animation FBX clips directory (`--clips-dir`)

## Modes

- `semi`: creates `<output>.review.blend` + `<output>.report.json`
- `full`: creates `<output>.glb` + `<output>.report.json`
- In `semi` mode, `idle` is assigned as active preview action (fallback: first available action) so timeline playback shows motion immediately.
- In `semi` mode, NLA tracks are left unmuted and timeline range is set to the preview action frame range for immediate playback.
- In `full` mode, NLA tracks remain active for export sampling, and `idle` is assigned as active action to avoid static-rest-pose clips.
- After rig bind, character roots are snapped to world origin (`X/Y=0`) and ground plane (`Z=0` in normalize mode, `Y=0` otherwise). The snap prefers foot-bone midpoint (`LeftFoot/RightFoot`) and falls back to mesh footprint center. Disable with `--snap-character-to-world off`.
- After world snap, target mesh object origins are moved to world `0/0/0` without moving the visible geometry, so Blender selection/runtime pivot sits between the feet.
- Lower-body rest stance is narrowed automatically when ground-level foot spacing is unusually wide (`--leg-stance-scale auto`). Disable with `--leg-stance-scale off`, or pass a numeric scale in `(0, 1]`.
- Horizontal root/hips translation curves are flattened by default (`--lock-root-motion auto`) to keep clips in-place and avoid global avatar sway/drift. Object-level armature `location` curves from imported FBX clips are normalized to origin as part of this step. Mixamo local-Y hips motion is preserved only as a small capped vertical bob (`--root-motion-vertical-max-range`, default `0.04`) and all clips are offset to the same vertical baseline so animation switches do not move the avatar up or down.
- Upper-body-only clips can also lock hips/root quaternion animation to the first frame with `--lock-root-rotation-states` (default: `auto`). In `auto` mode, clips with outlier hips rotation plus known upper-body states (`working`, `communicating`, `coffee-break`, `talking`, `at-phone`) are flattened so hips rotation, lower-body drift, and vertical hips bob stay planted; use `off` to disable or pass a comma-separated list of state names manually.
- `full` mode now re-imports the exported GLB into a clean Blender scene, measures the final grounded contact there, and applies one automatic vertical correction pass if the exported file still floats above the floor after export/import conversion. The report includes this under `exportValidation`.

## Default clip mapping

- `idle <- idle.fbx`
- `walking <- walking.fbx`
- `working <- thinking.fbx` (override via `--working-clip`)
- `communicating <- communicating.fbx`
- `coffee-break <- coffee-break.fbx`
- `at-phone <- at-phone.fbx`
- `teleport-out <- teleport-out.fbx`
- `teleport-in <- teleport-in.fbx`
- optional `talking <- talking.fbx` (override via `--talking-clip`)

## Usage

Validate clips before running Blender:

```bash
pnpm --dir desktop-avatar avatar:validate \
  --mode semi \
  --clips-dir /abs/path/clips \
  --working-clip thinking \
  --talking-clip talking
```

Machine-readable validation output:

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
  --output-glb /abs/path/build/female_avatar_1.glb \
  --auto-base-rotation auto \
  --rotation-target target-meshes \
  --align-target-to-base auto \
  --transfer-mode data-transfer
```

```bash
pnpm --dir desktop-avatar avatar:build \
  --mode full \
  --mesh-glb /abs/path/female_avatar_1.glb \
  --base-fbx /abs/path/female_avatar_1_base.fbx \
  --clips-dir /abs/path/clips \
  --output-glb /abs/path/build/female_avatar_1.glb \
  --desktop-target /abs/path/desktop-avatar/public/avatars/female_avatar_1.glb \
  --studio-target /abs/path/studio-assets/female_avatar_1.glb
```

For Tripo-rigged base FBX + Mixamo clips, use the dedicated runner:

```bash
pnpm --dir desktop-avatar avatar:build:tripo \
  --mode semi \
  --mesh-glb /abs/path/neutral_avatar_2.glb \
  --base-fbx /abs/path/neutral_avatar_2_base.fbx \
  --clips-dir /abs/path/clips \
  --output-glb /abs/path/build/neutral_avatar_2.glb
```

## Notes

- The runner auto-resolves Blender as:
  - `BLENDER_BIN` env var, otherwise
  - `/Applications/Blender.app/Contents/MacOS/Blender`, otherwise
  - `blender` from `PATH`.
- The runner starts Blender with `--factory-startup`; set `AVATAR_BUILD_GPU_BACKEND=metal` only if you need to override backend explicitly.
- `--desktop-target` and `--studio-target` are runner-only flags and are applied only in `full` mode.
- `avatar:build:tripo` is a wrapper over `avatar:build` that defaults `--clip-retarget-profile tripo`.
- `--clip-retarget-profile` supports `auto` (default), `off`, and `tripo`. `tripo` remaps common Mixamo bones (for example `mixamorig:Hips`, `mixamorig:LeftArm`) to Tripo names (`Pelvis`, `L_Upperarm`, etc.) before assigning actions.
- `avatar:validate --json` prints a structured payload (`ok`, `errors`, `warnings`, `resolved`, `extras`) for CI/scripts.
- If deformation quality is off in `semi`, inspect `<output>.review.blend`, adjust source assets, and re-run.
- Non-runtime objects imported from base FBX (helper/control meshes) are removed automatically after skin transfer so review/export scenes stay clean.
- Weight transfer defaults to geometry-based `data-transfer`; `index-copy` is available only as explicit opt-in.
- If base FBX and mesh GLB use different up-axes, `--auto-base-rotation auto` applies an inferred 90° alignment (report includes chosen axis/rotation).
- `--rotation-target normalize` (default) independently detects each asset's up axis (armature bones for the base, mesh bounds for the target) and rotates both hierarchies to Blender's +Z-up before weight transfer. Legacy values `target-meshes` and `base-and-armature` still behave as before.
- `--fbx-axis-forward` / `--fbx-axis-up` override Blender's FBX header-based axis conversion (both default to `auto`). Use matching values (e.g. `-Z` / `Y` for Mixamo) if Blender cannot read the FBX axes.
- `--translation-warn-threshold <meters>` (default `0.05`) emits a warning in the report when alignment has to move the target mesh farther than expected.
- FBX imports use `ignore_leaf_bones=True`, so leaf-only helper bones from exporters (Maya/Tripo) do not leak into the exported glTF.
- Before weight transfer, location/rotation/scale of source and target meshes are baked into the mesh data so `DATA_TRANSFER` samples in a consistent object space.
- `--align-target-to-base auto` (default) snaps target mesh position onto base rig space (horizontal center + floor contact) before weight transfer.
- `--leg-stance-scale auto` (default) measures ground-level foot-center spread after axis alignment. If spread is greater than `--leg-stance-target-ratio` (default `0.25`) times character height, the lower-body mesh vertices and leg/foot/toe rest bones are narrowed before weight transfer. The report includes `legStanceCorrection` with the measured spread and applied scale.
- In `normalize` mode the runner also aligns the target mesh's forward axis around Z: it compares the armature's left→right shoulder vector to the target's dominant horizontal footprint and snaps any mismatch to the nearest 90° rotation. Because the mesh footprint alone does not tell us *which way* the character faces, the result can end up 180° off. Use `--forward-axis-offset 0|90|180|270|-90|-180|-270` to override the heuristic with a manual Z rotation; `auto` (default) uses the shoulder-vs-footprint heuristic. If the residual after snapping exceeds 15°, a warning is emitted.
- The armature is forced to rest pose at import and again after clips are stashed to NLA, so `review.blend` and the exported GLB always ship the T-pose rather than the first frame of whichever clip was imported last.
- After `snap-character-to-world` moves the armature object, its `location` is applied (baked into bone rest data) so `armature.location == (0,0,0)` at export time. Without this, the glTF writer bakes the non-zero location into the armature node's TRS and re-importers see the pivot offset from world origin.
- Each imported clip is copied to a state-named action (`idle`, `walking`, …) and the original imported action (e.g. `mixamo.com|Layer0`) is removed immediately. Before export, a hard sweep removes every action whose name is not in the state mapping; the list of removed data-blocks is emitted as `removedForeignActions` in the report.
