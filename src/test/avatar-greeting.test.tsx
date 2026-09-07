import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimationClip, AnimationMixer, Group, VectorKeyframeTrack } from "three";
import type { AvatarRuntime } from "../lib/avatar-runtime";
import { AvatarStage } from "../components/AvatarStage";

const state = vi.hoisted(() => ({ runtime: null as AvatarRuntime | null, reduced: false, frames: new Set<(state: unknown, delta: number) => void>(), invalidate: vi.fn() }));
vi.mock("../hooks/useAvatarRuntime", () => ({ useAvatarRuntime: () => ({ runtime: state.runtime, error: null }) }));
vi.mock("../hooks/useAvatarReducedMotion", () => ({ useAvatarReducedMotion: () => state.reduced }));
vi.mock("../hooks/useAvatarVisibility", () => ({ useAvatarVisibility: () => true, avatarFrameLoop: () => "always" }));
vi.mock("@react-three/fiber", async () => {
  const React = await import("react");
  return {
    // Mount the actual rig; camera/lighting are covered separately, no WebGL needed here.
    Canvas: ({ children }: { children: React.ReactElement<{ children?: React.ReactNode }>[] }) => children.find(child => child.type === "group")?.props.children,
    useThree: (selector: (value: { invalidate: typeof state.invalidate }) => unknown) => selector({ invalidate: state.invalidate }),
    useFrame: (callback: (state: unknown, delta: number) => void) => React.useEffect(() => {
      state.frames.add(callback); return () => { state.frames.delete(callback); };
    }, [callback])
  };
});

function runtime(withWave = true): AvatarRuntime {
  const root = new Group(); root.name = "avatar";
  const mixer = new AnimationMixer(root);
  const clip = (name: string, x: number) => new AnimationClip(name, 1, [new VectorKeyframeTrack("avatar.position", [0, 1], [x, 0, 0, x, 0, 0])]);
  const idle = mixer.clipAction(clip("idle", 0));
  return { root, mixer, actions: { idle, ...(withWave ? { "teleport-out": mixer.clipAction(clip("teleport-out", 1)) } : {}) }, assetKind: "animation-library", resolvedAnimationMapping: {}, dispose: vi.fn() };
}
const props = { companionState: "idle" as const, expanded: false, manifest: null, onDragStart: vi.fn() };
function advance() { act(() => { for (let frame = 0; frame < 15; frame++) state.frames.forEach(callback => callback(null, .1)); }); }
afterEach(() => { cleanup(); state.runtime = null; state.reduced = false; state.frames.clear(); });

describe("loaded avatar greeting", () => {
  it("shows no placeholder while loading, starts in the wave pose and returns to idle once", () => {
    const debug = vi.fn(); const finished = vi.fn();
    const view = render(<AvatarStage {...props} onAnimationDebugChange={debug} onForcedAnimationFinished={finished} />);
    expect(view.container.querySelector("primitive, mesh, sphereGeometry")).toBeNull();
    state.runtime = runtime();
    view.rerender(<AvatarStage {...props} onAnimationDebugChange={debug} onForcedAnimationFinished={finished} />);
    expect(state.runtime.root.position.x).toBe(1);
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("teleport-out");
    advance();
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("idle");
    expect(finished).not.toHaveBeenCalled();
    advance();
    expect(state.runtime.root.position.x).toBe(0);
    state.runtime = runtime();
    view.rerender(<AvatarStage {...props} onAnimationDebugChange={debug} onForcedAnimationFinished={finished} />);
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("teleport-out");
  });
  it("honors explicit animation selection without a delayed greeting", () => {
    state.runtime = runtime(); const debug = vi.fn();
    const view = render(<AvatarStage {...props} forcedAnimation="idle" onAnimationDebugChange={debug} />);
    view.rerender(<AvatarStage {...props} onAnimationDebugChange={debug} />);
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("idle");
  });
  it("uses idle for models without the wave clip", () => {
    state.runtime = runtime(false); const debug = vi.fn();
    render(<AvatarStage {...props} onAnimationDebugChange={debug} />);
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("idle");
  });
  it("completes the greeting immediately in reduced motion", () => {
    state.runtime = runtime(); state.reduced = true; const debug = vi.fn();
    render(<AvatarStage {...props} onAnimationDebugChange={debug} />);
    expect(debug.mock.lastCall?.[0].selectedClip).toBe("idle");
    expect(state.runtime.root.position.x).toBe(0);
  });
});
