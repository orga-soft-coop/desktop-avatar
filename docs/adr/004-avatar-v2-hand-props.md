# ADR 004: Shared version-2 models, fingers and hand props

Status: accepted

## Decision

Adopt the complete version-2 exports for Female Avatar 1 and 2 from `agent-avatars`, replacing the earlier 33-bone copies. Preserve all 32 model/clip/prop/manifest files byte for byte and record their hashes. Consume the existing `avatar-body-hands-45` schema and per-clip hand transforms. Do not modify authoring sources or create a second rig, IK solver or coordinate conversion.

Map attention/listening to `taking-notes`, including its notebook and pen. Keep phone and drinking gestures available with their respective props. Normal talking/idle/greeting show no props. The existing once-per-load greeting, close Peek framing, aliases, one-shots and reduced motion remain intact.

The existing runtime owns loaded prop scenes; the existing playback controller switches attachments when its physical action changes. Reuse one loaded scene per prop per runtime, validating hand names through Three.js sanitization. Frame the model before attaching props. Detach and release props before disposing the figure, including partial failures and superseded loads. Wait for all outstanding clip/prop acquisitions before failure cleanup, so late assets cannot leak.

## Alternatives and boundaries

Do not retain version-1 compatibility because only the two current bundled libraries are supported. Loading four small prop GLBs with the existing clip preload keeps action selection synchronous and avoids a second async-selection state machine. A generic asset cache or dynamic authoring framework is unnecessary here. Thumb/index are simplified independent chains; other fingers bend together, and there is no facial rig or dynamic handwriting. Native IPC, tenant state and business actions remain unchanged.

## Updating and verifying

Refresh each full `agent-avatars/Blender/<avatar>/runtime` directory, then regenerate `public/avatars/provenance.json`. Verify the parser, prop transitions/cleanup, actual skeleton deformation and hand framing, followed by the frontend build and browser checks for both figures. The source project's current hand contact calibration is consumed unchanged; desktop checks do not certify all extreme close-up contacts or authenticated native business flows.

The integration was verified against all 32 source hashes. Focused parser, asset, playback, greeting, runtime and real-GLB tests passed, including attachment transitions, failed loads and reduced motion. The frontend production build and documentation checks/lint passed. Browser inspection confirmed notebook/pen and the complete Peek greeting hand for both figures, plus phone/cup transitions. Authenticated native business flows were outside this verification.

The writing-grip correction is authored in the same source generator: roll the writing hand by -90 degrees around the authored longitudinal axis and recompute its pen attachment and arm contact together. A standalone 180-degree roll intersected the page in close-up inspection. Cup orientation remains separate. Both canonical writing clips and editable Blender libraries are regenerated; runtime pose overrides remain unnecessary. Contact checks cover all gestures, and real-GLB tests sample a full writing loop for pen/page contact and wrist clearance.
