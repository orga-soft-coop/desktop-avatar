import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { AnimationAction, AnimationClip, AnimationMixer, Group, Object3D } from "three";
import type {
  AvatarManifest,
  CompanionState,
  DesktopAvatarAnimationKey
} from "../lib/contracts";
import { resolveAvatarAssets, type LoadedAnimationAsset } from "../lib/avatar-assets";
import {
  deriveAnimationCandidates,
  selectAnimationAction
} from "../lib/avatar-animation-selection";
import type { AvatarCameraConfig } from "../lib/avatar-stage-config";
import { DEFAULT_AVATAR_CAMERA_CONFIG } from "../lib/avatar-stage-config";
import { t } from "../lib/i18n";
import { loadAvatarAnimationClip } from "../lib/vrm-animation";
import { frontendLog } from "../lib/tauri";

interface AvatarStageProps {
  companionState: CompanionState;
  expanded: boolean;
  manifest: AvatarManifest | null;
  cameraConfig?: AvatarCameraConfig;
  forcedAnimation?: string | null;
  suggestedAnimation?: DesktopAvatarAnimationKey | null;
  onDragStart: () => void;
  onAnimationsLoaded?: (names: string[]) => void;
  onAnimationDebugChange?: (input: {
    assetKind: "legacy-vrm" | "packed-glb" | null;
    selectedClip: string | null;
    resolvedAnimationMapping: Record<string, string>;
  }) => void;
}

interface RuntimeState {
  root: Object3D;
  mixer: AnimationMixer;
  actions: Record<string, AnimationAction>;
  assetKind: "legacy-vrm" | "packed-glb";
  resolvedAnimationMapping: Record<string, string>;
  update: (delta: number) => void;
  cleanup: () => void;
}

function actionClipName(action: AnimationAction | undefined): string | null {
  if (!action || typeof action.getClip !== "function") {
    return null;
  }
  return action.getClip()?.name ?? null;
}

function collectMeshBounds(root: Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  const next = new THREE.Box3();
  const worldMatrix = new THREE.Matrix4();
  let hasBounds = false;

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.SkinnedMesh)) {
      return;
    }
    const geo = child.geometry;
    if (!geo) {
      return;
    }
    if (geo.boundingBox === null) {
      geo.computeBoundingBox();
    }
    if (!geo.boundingBox) {
      return;
    }

    worldMatrix.copy(child.matrixWorld);
    next.copy(geo.boundingBox).applyMatrix4(worldMatrix);
    if (hasBounds) {
      bounds.union(next);
    } else {
      bounds.copy(next);
      hasBounds = true;
    }
  });

  if (!hasBounds) {
    bounds.setFromObject(root);
  }
  return bounds;
}

function normalizeModelRoot(root: Object3D, targetHeight = 1.6): void {
  root.updateMatrixWorld(true);
  const bounds = collectMeshBounds(root);
  if (bounds.isEmpty()) {
    return;
  }

  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  root.position.x -= centerX;
  root.position.z -= centerZ;
  root.updateMatrixWorld(true);

  const centeredBounds = collectMeshBounds(root);
  const height = centeredBounds.max.y - centeredBounds.min.y;
  if (Number.isFinite(height) && height > 0.0001) {
    const scale = targetHeight / height;
    if (scale > 0.05 && scale < 20) {
      root.scale.multiplyScalar(scale);
      root.updateMatrixWorld(true);
    }
  }

  const scaledBounds = collectMeshBounds(root);
  if (Number.isFinite(scaledBounds.min.y)) {
    root.position.y -= scaledBounds.min.y;
  }
  root.updateMatrixWorld(true);
}

function resolveActionNameByCaseInsensitiveMatch(
  actions: Record<string, AnimationAction>,
  preferredName: string
): string | null {
  if (actions[preferredName]) {
    return preferredName;
  }
  const preferred = preferredName.trim().toLowerCase();
  for (const key of Object.keys(actions)) {
    if (key.trim().toLowerCase() === preferred) {
      return key;
    }
  }
  return null;
}

function CameraController({ config }: { config: AvatarCameraConfig }) {
  const camera = useThree((state) => state.camera as THREE.PerspectiveCamera);
  const size = useThree((state) => state.size);
  const targetPosition = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3());

  useEffect(() => {
    targetPosition.current.set(
      config.position.x,
      config.position.y,
      config.position.z * (size.height / config.referenceHeight)
    );
    targetLookAt.current.set(config.target.x, config.target.y, config.target.z);
    camera.fov = config.fov;
    camera.updateProjectionMatrix();
  }, [
    camera,
    config.fov,
    config.position.x,
    config.position.y,
    config.position.z,
    config.referenceHeight,
    config.target.x,
    config.target.y,
    config.target.z,
    size.height
  ]);

  useFrame(() => {
    const target = targetPosition.current;
    if (camera.position.distanceToSquared(target) > 0.000001) {
      camera.position.lerp(target, 0.08);
    }
    camera.lookAt(targetLookAt.current);
  });

  return null;
}

function PlaceholderOrb({ companionState }: { companionState: CompanionState }) {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (!meshRef.current) {
      return;
    }

    meshRef.current.rotation.y += 0.015;
    const pulseBase = companionState === "thinking" || companionState === "speaking" ? 0.1 : 0.05;
    const pulse = 1 + Math.sin(clock.elapsedTime * 2.2) * pulseBase;
    meshRef.current.scale.setScalar(pulse);
  });

  return (
    <mesh ref={meshRef} position={[0, 0.15, 0]}>
      <sphereGeometry args={[0.88, 64, 64]} />
      <meshStandardMaterial color="#7FB6DA" metalness={0.5} roughness={0.2} />
    </mesh>
  );
}

function AvatarRig({
  companionState,
  manifest,
  forcedAnimation,
  suggestedAnimation,
  onLoadError,
  onAnimationsLoaded,
  onAnimationDebugChange
}: {
  companionState: CompanionState;
  manifest: AvatarManifest | null;
  forcedAnimation?: string | null;
  suggestedAnimation?: DesktopAvatarAnimationKey | null;
  onLoadError?: (message: string | null) => void;
  onAnimationsLoaded?: (names: string[]) => void;
  onAnimationDebugChange?: (input: {
    assetKind: "legacy-vrm" | "packed-glb" | null;
    selectedClip: string | null;
    resolvedAnimationMapping: Record<string, string>;
  }) => void;
}) {
  const groupRef = useRef<Group>(null);
  const runtimeRef = useRef<RuntimeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runtimeVersion, setRuntimeVersion] = useState(0);

  useEffect(() => {
    let revoked = false;
    let localCleanup: (() => void) | null = null;

    async function loadRuntime() {
      if (!manifest || !groupRef.current) {
        const message = t("errors.avatarManifestMissing");
        setLoadError(message);
        onLoadError?.(message);
        onAnimationDebugChange?.({
          assetKind: null,
          selectedClip: null,
          resolvedAnimationMapping: {}
        });
        void frontendLog("error", `avatar manifest missing: ${message}`);
        return;
      }

      try {
        const assets = await resolveAvatarAssets(manifest);
        if (revoked || !groupRef.current) {
          assets.revoke();
          return;
        }
        const actions: Record<string, AnimationAction> = {};
        let mixer: AnimationMixer;
        let root: Object3D;
        let assetKind: "legacy-vrm" | "packed-glb";
        let resolvedAnimationMapping: Record<string, string> = {};
        let updateRuntime = (_delta: number) => {};
        let cleanupRuntime = () => {};

        if (assets.kind === "packed-glb") {
          assetKind = "packed-glb";
          const gltfLoader = new GLTFLoader();
          const gltf = await gltfLoader.loadAsync(assets.modelUrl);
          root = gltf.scene;
          normalizeModelRoot(root);

          mixer = new THREE.AnimationMixer(root);
          for (const clip of gltf.animations) {
            if (!clip.name?.trim()) {
              continue;
            }
            actions[clip.name] = mixer.clipAction(clip);
          }

          for (const [state, preferredClipName] of Object.entries(assets.animationMapping)) {
            if (!preferredClipName) {
              continue;
            }
            const resolved = resolveActionNameByCaseInsensitiveMatch(actions, preferredClipName);
            if (resolved && actions[resolved]) {
              actions[state] = actions[resolved];
              const clipName = actionClipName(actions[resolved]);
              if (clipName) {
                resolvedAnimationMapping[state] = clipName;
              }
            }
          }

          for (const [key, action] of Object.entries(actions)) {
            const clipName = actionClipName(action);
            if (clipName) {
              resolvedAnimationMapping[key] = clipName;
            }
          }

          cleanupRuntime = () => {
            mixer.stopAllAction();
            root.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                child.geometry?.dispose();
                if (Array.isArray(child.material)) {
                  child.material.forEach((material) => material.dispose());
                } else {
                  child.material?.dispose();
                }
              }
            });
          };
          void frontendLog(
            "info",
            `loaded packed GLB avatar with ${Object.keys(actions).length} action entries`
          );
        } else {
          assetKind = "legacy-vrm";
          const gltfLoader = new GLTFLoader();
          gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
          const gltf = await gltfLoader.loadAsync(assets.vrmUrl);
          const vrm = gltf.userData.vrm as VRM;

          VRMUtils.removeUnnecessaryVertices(gltf.scene);
          VRMUtils.removeUnnecessaryJoints(gltf.scene);
          VRMUtils.rotateVRM0(vrm);
          normalizeModelRoot(vrm.scene);

          mixer = new THREE.AnimationMixer(vrm.scene);
          root = vrm.scene;

          const loadClip = async (
            asset: LoadedAnimationAsset | null | undefined
          ): Promise<AnimationClip | null> => {
            if (!asset) {
              return null;
            }
            return loadAvatarAnimationClip(asset.url, asset.source, vrm);
          };

          const loadClipSafely = async (
            asset: LoadedAnimationAsset | null | undefined,
            label: string
          ) => {
            try {
              return await loadClip(asset);
            } catch (error) {
              console.warn(`Failed to load ${label} animation`, error);
              void frontendLog(
                "warn",
                `failed to load ${label} animation: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
              return null;
            }
          };

          const idleClips = (
            await Promise.all(
              assets.idleAnimationUrls.map((url, index) =>
                loadClipSafely(url, `idle-${index + 1}`)
              )
            )
          ).filter(Boolean) as AnimationClip[];

          const clips = {
            attention: await loadClipSafely(assets.attentionAnimationUrl, "attention"),
            thinking: await loadClipSafely(assets.thinkingAnimationUrl, "thinking"),
            talking: await loadClipSafely(assets.talkingAnimationUrl, "talking")
          };

          idleClips.forEach((clip, index) => {
            actions[`idle-${index}`] = mixer.clipAction(clip);
          });
          Object.entries(clips).forEach(([key, clip]) => {
            if (clip) {
              actions[key] = mixer.clipAction(clip);
            }
          });
          if (idleClips.length > 0) {
            resolvedAnimationMapping.idle = idleClips[0].name;
          }
          if (clips.attention) {
            resolvedAnimationMapping.attention = clips.attention.name;
          }
          if (clips.thinking) {
            resolvedAnimationMapping.thinking = clips.thinking.name;
            resolvedAnimationMapping.working = clips.thinking.name;
          }
          if (clips.talking) {
            resolvedAnimationMapping.talking = clips.talking.name;
            resolvedAnimationMapping.communicating = clips.talking.name;
          } else if (clips.attention) {
            resolvedAnimationMapping.communicating = clips.attention.name;
          } else if (idleClips.length > 0) {
            resolvedAnimationMapping.communicating = idleClips[0].name;
          }

          updateRuntime = (delta) => {
            vrm.update(delta);
          };
          cleanupRuntime = () => {
            mixer.stopAllAction();
            VRMUtils.deepDispose(vrm.scene);
          };
        }

        groupRef.current.clear();
        groupRef.current.add(root);
        root.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            child.castShadow = false;
            child.receiveShadow = false;
          }
        });

        runtimeRef.current = {
          root,
          mixer,
          actions,
          assetKind,
          resolvedAnimationMapping,
          update: updateRuntime,
          cleanup: () => {
            assets.revoke();
            cleanupRuntime();
          }
        };
        localCleanup = runtimeRef.current.cleanup;
        setLoadError(null);
        onLoadError?.(null);
        onAnimationDebugChange?.({
          assetKind,
          selectedClip: null,
          resolvedAnimationMapping
        });
        onAnimationsLoaded?.(Object.keys(actions));
        setRuntimeVersion((current) => current + 1);
        void frontendLog(
          "info",
          `avatar runtime ready: ${Object.keys(actions).length} animation actions loaded`
        );
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : t("errors.avatarLoadFailed");
        setLoadError(message);
        onLoadError?.(message);
        onAnimationDebugChange?.({
          assetKind: null,
          selectedClip: null,
          resolvedAnimationMapping: {}
        });
        void frontendLog("error", `avatar load failed: ${message}`);
      }
    }

    void loadRuntime();

    return () => {
      revoked = true;
      runtimeRef.current?.cleanup();
      runtimeRef.current = null;
      localCleanup?.();
    };
  }, [manifest]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    const { actions } = runtime;
    const fadeOutAll = () => {
      Object.values(actions).forEach((action) => action.fadeOut(0.24));
    };

    fadeOutAll();
    const selectedAction = selectAnimationAction(
      actions,
      deriveAnimationCandidates({
        companionState,
        forcedAnimation,
        suggestedAnimation
      })
    );

    if (selectedAction) {
      selectedAction.reset().fadeIn(0.24).play();
      selectedAction.loop = THREE.LoopRepeat;
    } else if (runtime.root) {
      runtime.root.rotation.y += companionState === "thinking" ? 0.08 : 0;
    }
    onAnimationDebugChange?.({
      assetKind: runtime.assetKind,
      selectedClip: actionClipName(selectedAction),
      resolvedAnimationMapping: runtime.resolvedAnimationMapping
    });
  }, [companionState, forcedAnimation, onAnimationDebugChange, runtimeVersion, suggestedAnimation]);

  useFrame((_, delta) => {
    runtimeRef.current?.mixer.update(delta);
    runtimeRef.current?.update(delta);
  });

  const fallback = useMemo(() => !manifest || loadError, [manifest, loadError]);

  return (
    <group ref={groupRef}>
      {fallback ? <PlaceholderOrb companionState={companionState} /> : null}
    </group>
  );
}

export function AvatarStage({
  companionState,
  expanded,
  manifest,
  cameraConfig = DEFAULT_AVATAR_CAMERA_CONFIG,
  forcedAnimation,
  suggestedAnimation,
  onDragStart,
  onAnimationsLoaded,
  onAnimationDebugChange
}: AvatarStageProps) {
  const [loadError, setLoadError] = useState<string | null>(null);

  return (
    <section className={`avatar-stage ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="avatar-stage__shadow" aria-hidden="true" />
      <div className="avatar-stage__frame">
        <div
          className="avatar-stage__surface"
          data-tauri-drag-region
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button, textarea, input")) {
              return;
            }
            onDragStart();
          }}
        >
          <Canvas
            camera={{
              position: [
                cameraConfig.position.x,
                cameraConfig.position.y,
                cameraConfig.position.z
              ],
              fov: cameraConfig.fov
            }}
            gl={{ alpha: true }}
            onCreated={({ scene, gl }) => {
              scene.background = null;
              gl.shadowMap.enabled = false;
            }}
          >
            <CameraController config={cameraConfig} />
            <ambientLight intensity={1.1} />
            <directionalLight position={[2.4, 4, 2.8]} intensity={2.8} />
            <pointLight position={[-2, 1.3, 2]} intensity={10} />
            <group position={[0, -1.05, 0]}>
              <AvatarRig
                companionState={companionState}
                manifest={manifest}
                forcedAnimation={forcedAnimation}
                suggestedAnimation={suggestedAnimation}
                onLoadError={setLoadError}
                onAnimationsLoaded={onAnimationsLoaded}
                onAnimationDebugChange={onAnimationDebugChange}
              />
            </group>
            <OrbitControls enabled={false} />
          </Canvas>
          {loadError ? (
            <div className="avatar-stage__error" role="status">
              {loadError}
            </div>
          ) : null}
        </div>
      </div>
      <div className="avatar-stage__ring" aria-hidden="true" />
      <div className="avatar-stage__pulse" data-state={companionState} />
    </section>
  );
}
