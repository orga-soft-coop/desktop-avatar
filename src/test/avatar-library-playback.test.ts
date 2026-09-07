import { expect, it, vi } from "vitest";
import { AnimationClip, AnimationMixer, Group, LoopOnce } from "three";
import { createAvatarPlayback } from "../lib/avatar-playback";

it("honors a library entry's non-loop policy even for teleport-in without an exit callback", () => {
  const root = new Group(); const mixer = new AnimationMixer(root);
  const action = mixer.clipAction(new AnimationClip("teleport-in", 1, []));
  const callback = vi.fn();
  const playback = createAvatarPlayback({ root, mixer, actions: { "teleport-in": action }, assetKind: "animation-library", actionLoops: new Map([[action, false]]), resolvedAnimationMapping: {}, dispose: () => {} });
  playback.select(["teleport-in"], "teleport-in", callback);
  for (let i = 0; i < 12; i++) playback.update(.1);
  expect(action.loop).toBe(LoopOnce);
  expect(action.paused).toBe(true);
  expect(callback).not.toHaveBeenCalled();
});
