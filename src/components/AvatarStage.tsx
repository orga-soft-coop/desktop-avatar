import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { AnimationAction, AnimationClip, AnimationMixer, Group } from "three";
import type { AvatarManifest, CompanionState } from "../lib/contracts";
import { resolveAvatarAssets, type LoadedAnimationAsset } from "../lib/avatar-assets";
import { loadAvatarAnimationClip } from "../lib/vrm-animation";
import { frontendLog } from "../lib/tauri";

interface AvatarStageProps {
  companionState: CompanionState;
  expanded: boolean;
  manifest: AvatarManifest | null;
  forcedAnimation?: string | null;
  onDragStart: () => void;
  onAnimationsLoaded?: (names: string[]) => void;
}

interface RuntimeState {
  vrm: VRM;
  mixer: AnimationMixer;
  actions: Record<string, AnimationAction>;
  cleanup: () => void;
}

// Keep the avatar at a constant visual size regardless of canvas height.
// Reference: at 780px canvas height the camera sits at Z = 4.0.
const REF_HEIGHT = 780;
const REF_CAMERA_Z = 4.0;

function CameraController() {
  const { camera, size } = useThree();
  const targetZ = useRef(REF_CAMERA_Z);

  // Update target whenever canvas height changes
  useEffect(() => {
    targetZ.current = REF_CAMERA_Z * (size.height / REF_HEIGHT);
  }, [size.height]);

  // Smoothly lerp toward the target each frame
  useFrame(() => {
    const current = camera.position.z;
    const target = targetZ.current;
    if (Math.abs(current - target) > 0.001) {
      camera.position.z += (target - current) * 0.08;
      camera.updateProjectionMatrix();
    }
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
      <meshStandardMaterial color="#8de8d8" metalness={0.5} roughness={0.2} />
    </mesh>
  );
}

function AvatarRig({
  companionState,
  manifest,
  forcedAnimation,
  onLoadError,
  onAnimationsLoaded
}: {
  companionState: CompanionState;
  manifest: AvatarManifest | null;
  forcedAnimation?: string | null;
  onLoadError?: (message: string | null) => void;
  onAnimationsLoaded?: (names: string[]) => void;
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
        const message = "No avatar manifest configured.";
        setLoadError(message);
        onLoadError?.(message);
        void frontendLog("error", `avatar manifest missing: ${message}`);
        return;
      }

      try {
        const assets = await resolveAvatarAssets(manifest);
        if (revoked || !groupRef.current) {
          assets.revoke();
          return;
        }

        const gltfLoader = new GLTFLoader();
        gltfLoader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await gltfLoader.loadAsync(assets.vrmUrl);
        const vrm = gltf.userData.vrm as VRM;

        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.removeUnnecessaryJoints(gltf.scene);
        VRMUtils.rotateVRM0(vrm);

        const mixer = new THREE.AnimationMixer(vrm.scene);
        const actions: Record<string, AnimationAction> = {};

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

        groupRef.current.clear();
        groupRef.current.add(vrm.scene);

        runtimeRef.current = {
          vrm,
          mixer,
          actions,
          cleanup: () => {
            assets.revoke();
            mixer.stopAllAction();
            VRMUtils.deepDispose(vrm.scene);
          }
        };
        localCleanup = runtimeRef.current.cleanup;
        setLoadError(null);
        onLoadError?.(null);
        onAnimationsLoaded?.(Object.keys(actions));
        setRuntimeVersion((current) => current + 1);
        void frontendLog(
          "info",
          `avatar runtime ready: ${Object.keys(actions).length} animation actions loaded`
        );
      } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : "Could not load avatar.";
        setLoadError(message);
        onLoadError?.(message);
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
    let selectedAction: AnimationAction | undefined;

    // Dev override: force a specific animation by key
    if (forcedAnimation && actions[forcedAnimation]) {
      selectedAction = actions[forcedAnimation];
    } else {
      const idleKeys = Object.keys(actions).filter((key) => key.startsWith("idle-"));
      const fallbackIdle =
        idleKeys.length > 0 ? actions[idleKeys[Math.floor(Math.random() * idleKeys.length)]] : undefined;

      if (companionState === "thinking" || companionState === "transcribing") {
        selectedAction = actions.thinking ?? fallbackIdle;
      } else if (companionState === "speaking") {
        selectedAction = actions.talking ?? fallbackIdle;
      } else if (companionState === "listening") {
        selectedAction = actions.attention ?? fallbackIdle;
      } else if (companionState === "idle") {
        selectedAction = fallbackIdle;
      }
    }

    if (selectedAction) {
      selectedAction.reset().fadeIn(0.24).play();
      selectedAction.loop = THREE.LoopRepeat;
    } else if (runtime.vrm.scene) {
      runtime.vrm.scene.rotation.y += companionState === "thinking" ? 0.08 : 0;
    }
  }, [companionState, forcedAnimation, runtimeVersion]);

  useFrame((_, delta) => {
    runtimeRef.current?.mixer.update(delta);
    runtimeRef.current?.vrm.update(delta);
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
  forcedAnimation,
  onDragStart,
  onAnimationsLoaded
}: AvatarStageProps) {
  const [loadError, setLoadError] = useState<string | null>(null);

  return (
    <section className={`avatar-stage ${expanded ? "is-expanded" : "is-collapsed"}`}>
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
          camera={{ position: [0, 0.95, 4.0], fov: 30 }}
          gl={{ alpha: true }}
          onCreated={({ scene }) => {
            scene.background = null;
          }}
        >
          <CameraController />
          <ambientLight intensity={1.1} />
          <directionalLight position={[2.4, 4, 2.8]} intensity={2.8} />
          <pointLight position={[-2, 1.3, 2]} intensity={10} />
          <group position={[0, -1.05, 0]}>
            <AvatarRig
              companionState={companionState}
              manifest={manifest}
              forcedAnimation={forcedAnimation}
              onLoadError={setLoadError}
              onAnimationsLoaded={onAnimationsLoaded}
            />
          </group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.32, 0]}>
            <circleGeometry args={[1.15, 64]} />
            <meshBasicMaterial color="#000000" transparent opacity={0.14} />
          </mesh>
          <OrbitControls enabled={false} />
        </Canvas>
        {loadError ? (
          <div className="avatar-stage__error" role="status">
            {loadError}
          </div>
        ) : null}
      </div>
      <div className="avatar-stage__pulse" data-state={companionState} />
    </section>
  );
}
