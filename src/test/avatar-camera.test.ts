import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR_CAMERA_CONFIG as config, resolveAvatarCameraPose } from "../lib/avatar-stage-config";

describe("Peek camera choreography", () => {
  const wave = (time: number) => ({ name: "teleport-out", time, duration: 2.5 });
  it("keeps the close portrait at rest and returns to it after the wave", () => {
    const rest = resolveAvatarCameraPose(config, 155, false);
    expect(rest.position.z).toBeCloseTo(1.05);
    expect(resolveAvatarCameraPose(config, 155, false, wave(0))).toEqual(rest);
    expect(resolveAvatarCameraPose(config, 155, false, wave(2.5))).toEqual(rest);
    const gesture = resolveAvatarCameraPose(config, 155, false, wave(1));
    expect(gesture.position.z).toBeGreaterThan(rest.position.z);
    expect(gesture.position.z).toBeLessThan(1.5);
    expect(gesture.target.x).toBeLessThan(rest.target.x);
    expect(gesture.target.y).toBeLessThan(rest.target.y);
  });
  it("uses the same composition for all circle sizes and leaves other clips still", () => {
    for (const height of [90, 155, 220]) {
      expect(resolveAvatarCameraPose(config, height, false, wave(1)))
        .toEqual(resolveAvatarCameraPose(config, 155, false, wave(1)));
      expect(resolveAvatarCameraPose(config, height, false, { ...wave(1), name: "talking" }))
        .toEqual(resolveAvatarCameraPose(config, height, false));
    }
  });
  it("disables the move for reduced motion and preserves expanded height scaling", () => {
    expect(resolveAvatarCameraPose(config, 155, false, wave(1), true))
      .toEqual(resolveAvatarCameraPose(config, 155, false));
    expect(resolveAvatarCameraPose(config, 390, true, wave(1)))
      .toEqual({ position: { x: 0, y: 0, z: 1.5 }, target: config.target });
  });
});
