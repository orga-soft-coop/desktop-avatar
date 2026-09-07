import { describe, expect, it, vi } from "vitest";
import { AnimationClip, AnimationMixer, Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture, VectorKeyframeTrack } from "three";
import { disposeAvatarScene, frameAvatarModel } from "../lib/avatar-scene";

describe("avatar scene ownership", () => {
  it("releases shared geometry/material/texture exactly once", () => {
    const root = new Group();
    const geometry = new BoxGeometry();
    const texture = new Texture();
    const material = new MeshStandardMaterial({ map: texture, emissiveMap: texture });
    root.add(new Mesh(geometry, material), new Mesh(geometry, material));
    const disposals = [geometry, material, texture].map(value => vi.spyOn(value, "dispose"));
    disposeAvatarScene(root);
    disposals.forEach(spy => expect(spy).toHaveBeenCalledTimes(1));
  });
  it("centers and grounds translated, non-unit models without modifying animated transforms", () => {
    const model = new Group();
    model.name = "figure";
    model.position.set(3, 2, 5);
    const mesh = new Mesh(new BoxGeometry(1, 2, 1));
    mesh.position.y = 1;
    model.add(mesh);
    const frame = frameAvatarModel(model);
    const mixer = new AnimationMixer(model);
    mixer.clipAction(new AnimationClip("pose", 1, [new VectorKeyframeTrack("figure.position", [0, 1], [3, 2, 5, 3, 2, 5])])).play();
    mixer.update(.5);
    const bounds = new Box3().setFromObject(frame, true);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(1.6);
    expect(bounds.min.x + bounds.max.x).toBeCloseTo(0);
    expect(bounds.min.z + bounds.max.z).toBeCloseTo(0);
    expect(model.position.toArray()).toEqual([3, 2, 5]);
  });
});
