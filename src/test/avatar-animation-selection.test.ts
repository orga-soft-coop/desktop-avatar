import { describe, expect, it } from "vitest";
import {
  deriveAnimationCandidates,
  normalizePackedAnimationMapping,
  selectAnimationAction
} from "../lib/avatar-animation-selection";

describe("avatar animation selection", () => {
  it("uses speaking fallback chain talking -> communicating -> idle", () => {
    const candidates = deriveAnimationCandidates({
      companionState: "speaking"
    });
    expect(candidates).toEqual(["talking", "communicating", "idle"]);
  });

  it("uses thinking fallback chain thinking -> working -> idle", () => {
    const candidates = deriveAnimationCandidates({
      companionState: "thinking"
    });
    expect(candidates).toEqual(["thinking", "working", "idle"]);
  });

  it("resolves actions with idle-* fallback", () => {
    const action = selectAnimationAction(
      {
        communicating: "communicating-action",
        "idle-0": "idle-action"
      },
      ["talking", "communicating", "idle"]
    );
    expect(action).toBe("communicating-action");
  });

  it("normalizes packed mapping by trimming and dropping empty values", () => {
    const mapping = normalizePackedAnimationMapping({
      working: " thinking ",
      talking: " ",
      idle: "idle"
    });
    expect(mapping).toEqual({
      working: "thinking",
      idle: "idle"
    });
  });
});
