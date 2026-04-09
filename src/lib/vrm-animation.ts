import * as THREE from "three";
import { VRM } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip
} from "@pixiv/three-vrm-animation";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MIXAMO_BONE_MAP = {
  mixamorigHips: "hips",
  mixamorigSpine: "spine",
  mixamorigSpine1: "chest",
  mixamorigSpine2: "upperChest",
  mixamorigNeck: "neck",
  mixamorigHead: "head",
  mixamorigLeftShoulder: "leftShoulder",
  mixamorigLeftArm: "leftUpperArm",
  mixamorigLeftForeArm: "leftLowerArm",
  mixamorigLeftHand: "leftHand",
  mixamorigLeftUpLeg: "leftUpperLeg",
  mixamorigLeftLeg: "leftLowerLeg",
  mixamorigLeftFoot: "leftFoot",
  mixamorigLeftToeBase: "leftToes",
  mixamorigRightShoulder: "rightShoulder",
  mixamorigRightArm: "rightUpperArm",
  mixamorigRightForeArm: "rightLowerArm",
  mixamorigRightHand: "rightHand",
  mixamorigRightUpLeg: "rightUpperLeg",
  mixamorigRightLeg: "rightLowerLeg",
  mixamorigRightFoot: "rightFoot",
  mixamorigRightToeBase: "rightToes",
  mixamorigLeftHandThumb1: "leftThumbMetacarpal",
  mixamorigLeftHandThumb2: "leftThumbProximal",
  mixamorigLeftHandThumb3: "leftThumbDistal",
  mixamorigLeftHandIndex1: "leftIndexProximal",
  mixamorigLeftHandIndex2: "leftIndexIntermediate",
  mixamorigLeftHandIndex3: "leftIndexDistal",
  mixamorigLeftHandMiddle1: "leftMiddleProximal",
  mixamorigLeftHandMiddle2: "leftMiddleIntermediate",
  mixamorigLeftHandMiddle3: "leftMiddleDistal",
  mixamorigLeftHandRing1: "leftRingProximal",
  mixamorigLeftHandRing2: "leftRingIntermediate",
  mixamorigLeftHandRing3: "leftRingDistal",
  mixamorigLeftHandPinky1: "leftLittleProximal",
  mixamorigLeftHandPinky2: "leftLittleIntermediate",
  mixamorigLeftHandPinky3: "leftLittleDistal",
  mixamorigRightHandThumb1: "rightThumbMetacarpal",
  mixamorigRightHandThumb2: "rightThumbProximal",
  mixamorigRightHandThumb3: "rightThumbDistal",
  mixamorigRightHandIndex1: "rightIndexProximal",
  mixamorigRightHandIndex2: "rightIndexIntermediate",
  mixamorigRightHandIndex3: "rightIndexDistal",
  mixamorigRightHandMiddle1: "rightMiddleProximal",
  mixamorigRightHandMiddle2: "rightMiddleIntermediate",
  mixamorigRightHandMiddle3: "rightMiddleDistal",
  mixamorigRightHandRing1: "rightRingProximal",
  mixamorigRightHandRing2: "rightRingIntermediate",
  mixamorigRightHandRing3: "rightRingDistal",
  mixamorigRightHandPinky1: "rightLittleProximal",
  mixamorigRightHandPinky2: "rightLittleIntermediate",
  mixamorigRightHandPinky3: "rightLittleDistal"
} as const;

function assetPathname(path: string): string {
  const [withoutHash] = path.split("#", 1);
  const [withoutQuery] = withoutHash.split("?", 1);
  return withoutQuery.toLowerCase();
}

function isFbxAnimation(path: string): boolean {
  return assetPathname(path).endsWith(".fbx");
}

function createMixamoClip(sourceClip: THREE.AnimationClip, asset: THREE.Object3D, vrm: VRM) {
  const restRotationInverse = new THREE.Quaternion();
  const parentRestWorldRotation = new THREE.Quaternion();
  const flatQuaternion = new THREE.Quaternion();
  const tracks: THREE.KeyframeTrack[] = [];

  const mixamoHips = asset.getObjectByName("mixamorigHips");
  const vrmHips = vrm.humanoid.getNormalizedBoneNode("hips");
  const mixamoHipsHeight = mixamoHips
    ? mixamoHips.getWorldPosition(new THREE.Vector3()).y || mixamoHips.position.y || 1
    : 1;
  const vrmHipsHeight = vrmHips
    ? vrmHips.getWorldPosition(new THREE.Vector3()).y || vrmHips.position.y || 1
    : 1;
  const hipsScale = vrmHipsHeight / mixamoHipsHeight;
  const isVrm0 = vrm.meta?.metaVersion === "0";

  for (const track of sourceClip.tracks) {
    const [mixamoRigName, propertyName] = track.name.split(".");
    const vrmBoneName =
      MIXAMO_BONE_MAP[mixamoRigName as keyof typeof MIXAMO_BONE_MAP];
    const vrmNode = vrmBoneName ? vrm.humanoid.getNormalizedBoneNode(vrmBoneName) : null;
    const mixamoRigNode = asset.getObjectByName(mixamoRigName);

    if (!vrmNode || !mixamoRigNode) {
      continue;
    }

    if (track instanceof THREE.QuaternionKeyframeTrack && propertyName === "quaternion") {
      mixamoRigNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation) ??
        parentRestWorldRotation.identity();

      const values = Array.from(track.values);
      for (let index = 0; index < values.length; index += 4) {
        flatQuaternion.fromArray(values, index);
        flatQuaternion
          .premultiply(parentRestWorldRotation)
          .multiply(restRotationInverse);
        flatQuaternion.toArray(values, index);
      }

      tracks.push(
        new THREE.QuaternionKeyframeTrack(`${vrmNode.name}.quaternion`, track.times, values)
      );
      continue;
    }

    if (
      track instanceof THREE.VectorKeyframeTrack &&
      propertyName === "position" &&
      vrmBoneName === "hips"
    ) {
      const values = Array.from(track.values);
      for (let index = 0; index < values.length; index += 3) {
        const x = values[index] * hipsScale;
        const y = values[index + 1] * hipsScale;
        const z = values[index + 2] * hipsScale;
        values[index] = isVrm0 ? -x : x;
        values[index + 1] = y;
        values[index + 2] = isVrm0 ? -z : z;
      }

      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNode.name}.position`, track.times, values));
    }
  }

  return new THREE.AnimationClip(sourceClip.name || "mixamo", sourceClip.duration, tracks);
}

export async function loadAvatarAnimationClip(
  url: string,
  source: string,
  vrm: VRM
): Promise<THREE.AnimationClip | null> {
  if (isFbxAnimation(source)) {
    const fbxLoader = new FBXLoader();
    const asset = await fbxLoader.loadAsync(url);
    const sourceClip = asset.animations[0];
    if (!sourceClip) {
      return null;
    }
    return createMixamoClip(sourceClip, asset, vrm);
  }

  const gltfLoader = new GLTFLoader();
  gltfLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const clipGltf = await gltfLoader.loadAsync(url);
  const vrmAnimation = clipGltf.userData.vrmAnimations?.[0];
  if (!vrmAnimation) {
    return null;
  }
  return createVRMAnimationClip(vrmAnimation, vrm);
}
