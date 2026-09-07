import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAvatarAssets } from "../lib/avatar-assets";

const library = { version: 2, skeleton: "avatar-body-hands-45", jointCount: 45, props: { pen: { url: "props/pen.glb" } }, avatar: "female_avatar_1", model: "avatar.glb", clips: [
  { name: "idle", url: "animations/idle.glb", loop: true }
] };
afterEach(() => vi.unstubAllGlobals());
describe("bundled avatar assets", () => {
  it.each(["female_avatar_1", "female_avatar_2"])("loads %s from frontend assets", async (id) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ...library, avatar: id }) }));
    vi.stubGlobal("fetch", fetch);
    const assets = await resolveAvatarAssets({ animationLibraryUrl: `/avatars/${id}/manifest.json`, animationMapping: { working: "idle" } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/avatars/${id}/manifest.json`);
    expect(assets.modelUrl).toBe(`/avatars/${id}/avatar.glb`);
    expect(assets.clips).toEqual([{ name: "idle", url: `/avatars/${id}/animations/idle.glb`, loop: true, props: [] }]);
    expect(assets.props.pen.url).toBe(`/avatars/${id}/props/pen.glb`);
    expect(assets.animationMapping.working).toBe("idle");
  });
  it.each([undefined, "/custom/manifest.json", "https://example.com/avatar/manifest.json", "/avatars/female_avatar_3/manifest.json"])("rejects unsupported selection %s before fetching", async (path) => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(resolveAvatarAssets({ animationLibraryUrl: path })).rejects.toThrow("GLB");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports unavailable and malformed libraries", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetch);
    const manifest = { animationLibraryUrl: "/avatars/female_avatar_1/manifest.json" };
    await expect(resolveAvatarAssets(manifest)).rejects.toThrow("404");
    await expect(resolveAvatarAssets(manifest)).rejects.toThrow("Invalid avatar library");
  });
});
