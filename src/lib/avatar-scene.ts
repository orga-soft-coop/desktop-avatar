import { Box3, Group, Mesh, Object3D, Skeleton, ShaderMaterial, SkinnedMesh, Texture, type Material } from "three";

/** Own imported resources once, including resources shared by multiple primitives. */
export function disposeAvatarScene(root: Object3D): void {
  const geometries = new Set<Mesh["geometry"]>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
      if (material instanceof ShaderMaterial) {
        for (const uniform of Object.values(material.uniforms)) {
          if (uniform.value instanceof Texture) textures.add(uniform.value);
        }
      }
    }
    if (object instanceof SkinnedMesh) skeletons.add(object.skeleton);
  });
  skeletons.forEach((skeleton) => skeleton.dispose());
  const bitmaps = new Set<ImageBitmap>();
  textures.forEach((texture) => {
    if (typeof ImageBitmap !== "undefined" && texture.source.data instanceof ImageBitmap) {
      bitmaps.add(texture.source.data);
    }
    texture.dispose();
  });
  bitmaps.forEach((bitmap) => bitmap.close());
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

/** Normalize outside the animated hierarchy so root tracks cannot undo the fit. */
export function frameAvatarModel(model: Object3D, targetHeight = 1.6): Group {
  const frame = new Group();
  frame.add(model);
  model.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(model, true);
  const height = bounds.max.y - bounds.min.y;
  if (bounds.isEmpty() || !Number.isFinite(height) || height <= 0.0001) return frame;
  const scale = targetHeight / height;
  frame.scale.setScalar(scale);
  frame.position.set(
    -(bounds.min.x + bounds.max.x) * scale / 2,
    -bounds.min.y * scale,
    -(bounds.min.z + bounds.max.z) * scale / 2
  );
  frame.updateMatrixWorld(true);
  return frame;
}
