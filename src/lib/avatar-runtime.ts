import { AnimationMixer, Mesh, PropertyBinding, type AnimationAction, type AnimationClip, type Object3D } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AvatarAssetKind, AvatarManifest } from "./contracts";
import { resolveAvatarAssets } from "./avatar-assets";
import { disposeAvatarScene, frameAvatarModel } from "./avatar-scene";

export interface AvatarRuntime {
  root: Object3D;
  mixer: AnimationMixer;
  actions: Record<string, AnimationAction>;
  assetKind: AvatarAssetKind;
  actionLoops?: Map<AnimationAction, boolean>;
  resolvedAnimationMapping: Record<string, string>;
  setActiveAction?: (action?: AnimationAction) => void;
  dispose: () => void;
}

/** A load owns everything it acquires, including failures before React mounts it. */
export async function loadAvatarRuntime(manifest: AvatarManifest): Promise<AvatarRuntime> {
  const assets = await resolveAvatarAssets(manifest);
  let model: Object3D | undefined;
  let mixer: AnimationMixer | undefined;
  const props = new Map<string, Object3D>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const prop of props.values()) {
      prop.removeFromParent();
      disposeAvatarScene(prop);
    }
    props.clear();
    if (model) {
      mixer?.stopAllAction();
      mixer?.uncacheRoot(model);
      disposeAvatarScene(model);
    }
  };

  try {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(assets.modelUrl);
    model = gltf.scene;
    const actions: Record<string, AnimationAction> = Object.create(null);
    mixer = new AnimationMixer(model);
    const add = (key: string, clip: AnimationClip | null) => {
      if (clip) actions[key] = mixer!.clipAction(clip);
    };

    const actionLoops = new Map<AnimationAction, boolean>();
    // Wait for all clip loads before cleanup on failure; late loads own their scenes.
    const results = await Promise.allSettled([...assets.clips.map(async (entry) => {
      const asset = await new GLTFLoader().loadAsync(entry.url);
      try {
        const clip = asset.animations.find((clip) => clip.name === entry.name);
        if (!clip) throw new Error(`Avatar library clip is missing: ${entry.name}`);
        add(entry.name, clip);
        actionLoops.set(actions[entry.name], entry.loop);
      } finally {
        disposeAvatarScene(asset.scene);
      }
    }), ...Object.entries(assets.props).map(async ([id, entry]) => {
      const asset = await new GLTFLoader().loadAsync(entry.url);
      asset.scene.name = `Attached_${id}`;
      props.set(id, asset.scene);
    })]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // Resolve against original clip names: aliases must not overwrite one another.
    const clipActions = { ...actions };
    for (const [state, name] of Object.entries(assets.animationMapping)) {
      const key = Object.keys(clipActions).find((key) => key.toLowerCase() === name?.toLowerCase());
      if (key) actions[state] = clipActions[key];
    }
    model.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    const resolvedAnimationMapping = Object.fromEntries(
      Object.entries(actions).map(([key, action]) => [key, action.getClip().name])
    );
    // Frame the figure alone, before attaching any props to its hands.
    const root = frameAvatarModel(model);
    const attachments = new Map(assets.clips.map(entry => [clipActions[entry.name], entry.props.map(attachment => {
      const bone = model!.getObjectByName(PropertyBinding.sanitizeNodeName(attachment.bone));
      if (!bone) throw new Error(`Avatar attachment hand is missing: ${attachment.bone}`);
      const object = props.get(attachment.prop);
      if (!object) throw new Error(`Avatar attachment prop is missing: ${attachment.prop}`);
      return { bone, object, attachment };
    })]));
    const setActiveAction = (action?: AnimationAction) => {
      if (disposed) return;
      for (const prop of props.values()) prop.removeFromParent();
      for (const { bone, object, attachment } of (action && attachments.get(action)) || []) {
        bone.add(object);
        object.position.fromArray(attachment.position);
        object.quaternion.fromArray(attachment.quaternion);
        object.scale.fromArray(attachment.scale);
      }
    };
    // Library rootHeightOffset is provenance: it is already baked into the clip tracks.
    return {
      root, mixer, actions, actionLoops,
      assetKind: "animation-library", resolvedAnimationMapping,
      setActiveAction, dispose
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
