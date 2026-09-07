import { describe, expect, it, vi } from "vitest";
import { AnimationClip, AnimationMixer, Group, NumberKeyframeTrack } from "three";
import { createAvatarPlayback } from "../lib/avatar-playback";

function fixture() {
  const root = new Group();
  const mixer = new AnimationMixer(root);
  const action = (name: string) => mixer.clipAction(new AnimationClip(name, 1, [new NumberKeyframeTrack(".rotation[x]", [0, 1], [0, 1])]));
  const idle = action("Idle");
  const thinking = action("Thinking");
  const exit = action("Shrink");
  const runtime = { root, mixer, actions: { idle, thinking, working: thinking, Shrink: exit, "teleport-out": exit }, assetKind: "animation-library" as const, resolvedAnimationMapping: {}, dispose: vi.fn() };
  return { ...runtime, playback: createAvatarPlayback(runtime) };
}

describe("avatar playback", () => {
  it("preserves phase for repeated selections and state aliases", () => {
    const { playback, actions } = fixture();
    playback.select(["thinking"]);
    playback.update(.1);
    playback.update(.1);
    playback.select(["working"]);
    expect(actions.thinking.time).toBeCloseTo(.2);
  });
  it("stops outgoing actions after the crossfade and can reselect a retiring action", () => {
    const { playback, actions } = fixture();
    playback.select(["idle"]);
    playback.update(.1);
    playback.select(["thinking"]);
    playback.update(.1);
    playback.select(["idle"]);
    for (let i = 0; i < 4; i++) playback.update(.1);
    expect(actions.idle.isRunning()).toBe(true);
    expect(actions.thinking.isRunning()).toBe(false);
  });
  it("completes a mapped exit once using the requested name even when the clip differs", () => {
    const { playback, actions } = fixture();
    const finish = vi.fn();
    playback.select(["teleport-out"], "teleport-out", finish);
    for (let i = 0; i < 15; i++) playback.update(.1);
    expect(finish).toHaveBeenCalledExactlyOnceWith("teleport-out");
    expect(actions["teleport-out"].paused).toBe(true);
    playback.select(["teleport-out"], "teleport-out", finish);
    playback.update(.1);
    expect(finish).toHaveBeenCalledTimes(1);
  });
  it("does not treat a missing forced exit's idle fallback as a completed exit", () => {
    const { playback } = fixture();
    const finish = vi.fn();
    playback.select(["teleported-out"], "teleported-out", finish);
    for (let i = 0; i < 15; i++) playback.update(.1);
    expect(finish).not.toHaveBeenCalled();
  });
  it("bounds resume deltas and resolves exit lifecycle with reduced motion", () => {
    const { playback, actions } = fixture();
    playback.select(["idle"]);
    playback.update(40);
    expect(actions.idle.time).toBeCloseTo(.1);
    playback.update(.1, true);
    expect(actions.idle.time).toBe(0);
    const finish = vi.fn();
    playback.select(["teleport-out"], "teleport-out", finish);
    playback.update(.01, true);
    playback.update(.01, true);
    expect(finish).toHaveBeenCalledExactlyOnceWith("teleport-out");
  });
  it("can restart after effect cleanup without duplicate listeners", () => {
    const { playback } = fixture();
    const finish = vi.fn();
    playback.select(["idle"]);
    playback.dispose();
    playback.select(["teleport-out"], "teleport-out", finish);
    playback.update(.1, true);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});
