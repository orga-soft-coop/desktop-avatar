import { describe, expect, it, vi } from "vitest";
import { resolveAvatarAssets } from "../lib/avatar-assets";

const mocks = vi.hoisted(() => ({
  loadAvatarAssetMock: vi.fn(async (path: string) => `blob:${path}`)
}));

vi.mock("../lib/tauri", () => ({
  loadAvatarAsset: mocks.loadAvatarAssetMock
}));

describe("avatar assets resolver", () => {
  it("resolves packed GLB manifests", async () => {
    const assets = await resolveAvatarAssets({
      modelUrl: "./avatars/female_avatar_1.glb",
      animationMapping: {
        working: "thinking",
        talking: "talking"
      }
    });

    expect(assets.kind).toBe("packed-glb");
    if (assets.kind === "packed-glb") {
      expect(assets.modelUrl).toContain(".glb");
      expect(assets.animationMapping.working).toBe("thinking");
    }
  });

  it("rejects legacy manifests without idle animation urls", async () => {
    await expect(
      resolveAvatarAssets({
        vrmUrl: "./avatars/legacy.vrm",
        idleAnimationUrls: []
      })
    ).rejects.toThrow("idleAnimationUrl");
  });
});
