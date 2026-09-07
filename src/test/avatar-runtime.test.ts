import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnimationClip, Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { loadAvatarRuntime } from "../lib/avatar-runtime";
import { createAvatarPlayback } from "../lib/avatar-playback";
import type { LoadedAvatarAssets } from "../lib/avatar-assets";
const mocks = vi.hoisted(() => ({ assets: vi.fn(), load: vi.fn() }));
vi.mock("../lib/avatar-assets", () => ({ resolveAvatarAssets: mocks.assets }));
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({ GLTFLoader: class { loadAsync = mocks.load; } }));
const manifest = { displayName: "Female", animationLibraryUrl: "/avatars/female_avatar_1/manifest.json" };
const clip = (name: string) => ({ name, url: name, loop: true, props: [] });
const assets = (overrides: Partial<LoadedAvatarAssets> = {}): LoadedAvatarAssets => ({
  modelUrl: "model", clips: [clip("idle")], props: {}, animationMapping: {}, ...overrides
});
const meshScene = () => { const scene = new Group(); const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial()); scene.add(mesh); return { scene, mesh }; };

beforeEach(() => { vi.resetAllMocks(); mocks.assets.mockResolvedValue(assets()); });
describe("avatar runtime factory", () => {
  it("disposes imported mesh resources and mixer bindings idempotently", async () => {
    const { scene, mesh } = meshScene();
    const dispose = vi.spyOn(mesh.geometry, "dispose");
    mocks.load.mockImplementation(async (url: string) => ({ scene: url === "model" ? scene : new Group(), animations: [new AnimationClip("idle", 1, [])] }));
    const runtime = await loadAvatarRuntime(manifest);
    const uncache = vi.spyOn(runtime.mixer, "uncacheRoot");
    runtime.dispose(); runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(uncache).toHaveBeenCalledExactlyOnceWith(scene);
  });
  it("reports a model parse failure", async () => {
    mocks.load.mockRejectedValue(new Error("broken model"));
    await expect(loadAvatarRuntime(manifest)).rejects.toThrow("broken model");
  });
  it("resolves mappings from original clip names even when mappings swap names", async () => {
    mocks.assets.mockResolvedValue(assets({ clips: [clip("idle"), clip("talking")], animationMapping: { idle: "Talking", talking: "Idle" } }));
    mocks.load.mockImplementation(async () => ({ scene: new Group(), animations: [new AnimationClip("idle", 1, []), new AnimationClip("talking", 1, [])] }));
    const runtime = await loadAvatarRuntime(manifest);
    expect(runtime.actions.idle.getClip().name).toBe("talking");
    expect(runtime.actions.talking.getClip().name).toBe("idle");
    runtime.dispose();
  });
  it("cleans up the figure, successful clip and late prop when another clip fails", async () => {
    const figure = meshScene(); const extra = meshScene(); const prop = meshScene();
    const disposals = [figure, extra, prop].map(item => vi.spyOn(item.mesh.geometry, "dispose"));
    mocks.assets.mockResolvedValue(assets({ clips: [clip("idle"), clip("bad")], props: { pen: { url: "pen" } } }));
    let release!: () => void;
    mocks.load.mockImplementation(async (url: string) => {
      if (url === "bad") throw new Error("clip unavailable");
      if (url === "pen") { await new Promise<void>(resolve => { release = resolve; }); return { scene: prop.scene }; }
      return { scene: url === "model" ? figure.scene : extra.scene, animations: [new AnimationClip("idle", 1, [])] };
    });
    const pending = loadAvatarRuntime(manifest);
    const rejected = expect(pending).rejects.toThrow("clip unavailable");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release(); await rejected;
    disposals.forEach(dispose => expect(dispose).toHaveBeenCalledTimes(1));
  });
  it("attaches props using sanitized hands, preserves aliases and removes props on transition/disposal", async () => {
    const figure = meshScene(); const prop = meshScene();
    const hand = new Bone(); hand.name = "DEF-handR"; figure.scene.add(hand);
    const attachment = { prop: "pen", bone: "DEF-hand.R", position: [.01, .02, .03] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
    mocks.assets.mockResolvedValue(assets({ props: { pen: { url: "pen" } }, clips: [clip("idle"), { ...clip("taking-notes"), props: [attachment] }], animationMapping: { attention: "taking-notes" } }));
    mocks.load.mockImplementation(async (url: string) => ({ scene: url === "model" ? figure.scene : url === "pen" ? prop.scene : new Group(), animations: [new AnimationClip(url, 1, [])] }));
    const dispose = vi.spyOn(prop.mesh.geometry, "dispose");
    const runtime = await loadAvatarRuntime(manifest); const playback = createAvatarPlayback(runtime);
    expect(prop.scene.parent).toBeNull();
    playback.select(["attention"]);
    expect(prop.scene.parent).toBe(hand);
    expect(prop.scene.position.toArray()).toEqual(attachment.position);
    playback.update(.1); playback.select(["taking-notes"]);
    expect(runtime.actions.attention.time).toBeCloseTo(.1);
    playback.select(["idle"]); expect(prop.scene.parent).toBeNull();
    playback.select(["attention"]); playback.dispose(); expect(prop.scene.parent).toBeNull();
    runtime.dispose(); runtime.dispose(); expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched hand rigs and disposes the loaded prop", async () => {
    const prop = meshScene(); const dispose = vi.spyOn(prop.mesh.geometry, "dispose");
    mocks.assets.mockResolvedValue(assets({ props: { pen: { url: "pen" } }, clips: [{ ...clip("idle"), props: [{ prop: "pen", bone: "DEF-hand.R", position: [0,0,0], quaternion: [0,0,0,1], scale: [1,1,1] }] }] }));
    mocks.load.mockImplementation(async (url: string) => ({ scene: url === "pen" ? prop.scene : new Group(), animations: [new AnimationClip("idle", 1, [])] }));
    await expect(loadAvatarRuntime(manifest)).rejects.toThrow("hand is missing");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
