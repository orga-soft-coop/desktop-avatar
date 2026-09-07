// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AnimationMixer, Box3, Group, PerspectiveCamera, Texture, TextureLoader, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { loadAvatarRuntime } from "../lib/avatar-runtime";
import { createAvatarPlayback } from "../lib/avatar-playback";
import { parseAvatarLibrary } from "../lib/avatar-library";
import { frameAvatarModel, disposeAvatarScene } from "../lib/avatar-scene";
import { DEFAULT_AVATAR_CAMERA_CONFIG, resolveAvatarCameraPose } from "../lib/avatar-stage-config";

const publicRoot = new URL("../../public/avatars/", import.meta.url);
async function read(path) { return readFile(new URL(path, publicRoot)); }
async function parse(path) {
  const bytes = await read(path);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

describe("canonical shared avatar artifacts", () => {
  it("matches every recorded source byte hash", async () => {
    const provenance = JSON.parse((await read("provenance.json")).toString());
    expect(Object.keys(provenance.files)).toHaveLength(32);
    for (const [path, entry] of Object.entries(provenance.files)) {
      expect(createHash("sha256").update(await read(path)).digest("hex"), path).toBe(entry.sha256);
    }
  });
  it("uses distinct authored listening and speaking motions for both bundled figures", async () => {
    for (const manifestName of ["sample-avatar-manifest.json", "sample-avatar-2-manifest.json"]) {
      const manifest = JSON.parse((await readFile(new URL(`../../public/${manifestName}`, import.meta.url))).toString());
      const library = JSON.parse((await read(`${manifest.displayName}/manifest.json`)).toString());
      const listening = library.clips.find(clip => clip.name === manifest.animationMapping.attention);
      const speaking = library.clips.find(clip => clip.name === manifest.animationMapping.talking);
      expect(listening.name).toBe("taking-notes");
      expect(speaking.name).toBe("talking");
      expect(listening.url).not.toBe(speaking.url);
      expect(listening.props.map(entry => entry.prop)).toEqual(["notebook", "pen"]);
    }
  });
  it.each(["female_avatar_1", "female_avatar_2"])("binds all %s clips to the actual model skeleton without non-finite deformations", async (name) => {
    vi.stubGlobal("self", globalThis);
    // Node has no image decoder. Geometry, skeleton, tracks and pose evaluation are real;
    // texture appearance is checked in the browser preview.
    const textures = vi.spyOn(TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
      const texture = new Texture(); queueMicrotask(() => loaded?.(texture)); return texture;
    });
    const warning = vi.spyOn(console, "warn");
    try {
      const library = parseAvatarLibrary(JSON.parse((await read(`${name}/manifest.json`)).toString()));
      const model = await parse(`${name}/${library.model}`);
      model.scene.traverse(mesh => { if (mesh.isSkinnedMesh) expect(mesh.skeleton.bones).toHaveLength(45); });
      const frame = frameAvatarModel(model.scene);
      const mixer = new AnimationMixer(model.scene);
      for (const entry of library.clips) {
        const asset = await parse(`${name}/${entry.url}`);
        const clip = asset.animations.find(clip => clip.name === entry.name);
        expect(clip, entry.name).toBeDefined();
        const action = mixer.clipAction(clip); action.play();
        mixer.update(clip.duration * .35);
        const bounds = new Box3().setFromObject(frame, true);
        expect(bounds.isEmpty(), entry.name).toBe(false);
        expect([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite), entry.name).toBe(true);
        expect(bounds.max.y - bounds.min.y, entry.name).toBeLessThan(3);
        mixer.stopAllAction();
        disposeAvatarScene(asset.scene);
      }
      expect(warning.mock.calls.filter(args => String(args[0]).includes("PropertyBinding"))).toEqual([]);
      mixer.uncacheRoot(model.scene); disposeAvatarScene(model.scene);
    } finally {
      textures.mockRestore(); warning.mockRestore(); vi.unstubAllGlobals();
    }
  });
  it.each(["female_avatar_1", "female_avatar_2"])("frames %s waving hand during the Peek camera move", async (name) => {
    vi.stubGlobal("self", globalThis);
    const textures = vi.spyOn(TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
      const texture = new Texture(); queueMicrotask(() => loaded?.(texture)); return texture;
    });
    let model, asset, mixer;
    try {
      model = await parse(`${name}/avatar.glb`);
      asset = await parse(`${name}/animations/teleport-out.glb`);
      const stage = new Group(); stage.position.y = -1.05;
      stage.add(frameAvatarModel(model.scene));
      mixer = new AnimationMixer(model.scene);
      const vertices = [];
      model.scene.traverse(mesh => {
        if (!mesh.isSkinnedMesh) return;
        const indices = mesh.geometry.attributes.skinIndex;
        const weights = mesh.geometry.attributes.skinWeight;
        for (let index = 0; index < indices.count; index++) {
          for (let slot = 0; slot < 4; slot++) {
            const bone = mesh.skeleton.bones[indices.getComponent(index, slot)];
            if (/^DEF-(hand|thumb|index|fingers).*R$/.test(bone?.name ?? "") && weights.getComponent(index, slot) > 0.5) {
              vertices.push({ mesh, index }); break;
            }
          }
        }
      });
      expect(vertices.length).toBeGreaterThan(0);
      const config = DEFAULT_AVATAR_CAMERA_CONFIG;
      const camera = new PerspectiveCamera(config.fov, 1, 0.1, 100);
      const initial = resolveAvatarCameraPose(config, 155, false);
      camera.position.set(initial.position.x, initial.position.y, initial.position.z);
      const lookAt = new Vector3(initial.target.x, initial.target.y, initial.target.z);
      const clip = asset.animations[0]; mixer.clipAction(clip).play();
      let maxRadius = 0;
      const point = new Vector3();
      for (let sample = 0; sample < clip.duration * 60; sample++) {
        const time = sample / 60;
        mixer.setTime(time); stage.updateMatrixWorld(true);
        const pose = resolveAvatarCameraPose(config, 155, false, { name: clip.name, time, duration: clip.duration });
        camera.position.lerp(new Vector3(pose.position.x, pose.position.y, pose.position.z), 1 - Math.exp(-5 / 60));
        lookAt.lerp(new Vector3(pose.target.x, pose.target.y, pose.target.z), 1 - Math.exp(-5 / 60));
        camera.lookAt(lookAt); camera.updateMatrixWorld(true);
        // The middle of this authored clip is the wave; lead-in/out lower the arm.
        if (time < clip.duration * 0.3 || time > clip.duration * 0.76) continue;
        for (const { mesh, index } of vertices) {
          mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld).project(camera);
          maxRadius = Math.max(maxRadius, Math.hypot(point.x, point.y));
        }
      }
      expect(maxRadius).toBeGreaterThan(0);
      expect(maxRadius).toBeLessThan(0.94);
    } finally {
      if (model) { mixer?.uncacheRoot(model.scene); disposeAvatarScene(model.scene); }
      if (asset) disposeAvatarScene(asset.scene);
      textures.mockRestore(); vi.unstubAllGlobals();
    }
  });
});

it.each(["female_avatar_1", "female_avatar_2"])("switches real %s props with the production runtime and playback", async (name) => {
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("fetch", async path => ({ ok: true, json: async () => JSON.parse((await read(path.replace("/avatars/", ""))).toString()) }));
  const textures = vi.spyOn(TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
    const texture = new Texture(); queueMicrotask(() => loaded?.(texture)); return texture;
  });
  const load = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(url => parse(url.replace("/avatars/", "")));
  let runtime, playback;
  try {
    runtime = await loadAvatarRuntime({ animationLibraryUrl: `/avatars/${name}/manifest.json`, animationMapping: { attention: "taking-notes" } });
    playback = createAvatarPlayback(runtime);
    for (const [clip, props] of [["attention", ["notebook", "pen"]], ["at-phone", ["phone"]], ["coffee-break", ["cup"]], ["idle", []]]) {
      playback.select([clip]);
      for (let frame = 0; frame < 20; frame++) playback.update(.1);
      runtime.root.updateMatrixWorld(true);
      const attached = [];
      runtime.root.traverse(object => {
        if (!object.name.startsWith("Attached_")) return;
        attached.push(object.name.replace("Attached_", ""));
        expect(object.parent.isBone).toBe(true);
        expect(object.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      });
      expect(attached.sort()).toEqual(props.sort());
    }
    playback.select(["attention"]); playback.update(0, true);
    expect(runtime.root.getObjectByName("Attached_notebook").parent.name).toBe("DEF-handL");
    expect(runtime.root.getObjectByName("Attached_pen").parent.name).toBe("DEF-handR");
    const notebook = runtime.root.getObjectByName("Attached_notebook");
    const pen = runtime.root.getObjectByName("Attached_pen");
    // Evaluate a complete writing loop in exported Y-up coordinates: the tip
    // stays on the page while the rolled wrist remains above its surface.
    for (let frame = 0; frame <= 240; frame++) {
      playback.update(1 / 30);
      runtime.root.updateMatrixWorld(true);
      const tip = notebook.worldToLocal(pen.localToWorld(new Vector3(0, -.025, 0)));
      const wrist = notebook.worldToLocal(pen.parent.getWorldPosition(new Vector3()));
      expect(Math.abs(tip.x)).toBeLessThan(.049);
      expect(Math.abs(tip.z)).toBeLessThan(.034);
      expect(tip.y).toBeGreaterThan(.0048);
      expect(tip.y).toBeLessThan(.0091);
      expect(wrist.y).toBeGreaterThan(.01);
    }
    playback.dispose();
    expect(runtime.root.getObjectByName("Attached_pen")).toBeUndefined();
  } finally {
    playback?.dispose(); runtime?.dispose(); load.mockRestore(); textures.mockRestore(); vi.unstubAllGlobals();
  }
});
