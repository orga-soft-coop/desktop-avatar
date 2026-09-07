import { avatarFrameLoop, useAvatarVisibility } from "../hooks/useAvatarVisibility";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { AvatarAnimationDebug, AvatarManifest, CompanionState, DesktopAvatarAnimationKey } from "../lib/contracts";
import { deriveAnimationCandidates } from "../lib/avatar-animation-selection";
import { createAvatarPlayback } from "../lib/avatar-playback";
import { useAvatarRuntime } from "../hooks/useAvatarRuntime";
import { useAvatarReducedMotion } from "../hooks/useAvatarReducedMotion";
import { DEFAULT_AVATAR_CAMERA_CONFIG, resolveAvatarCameraPose, type AvatarCameraConfig } from "../lib/avatar-stage-config";

interface AvatarStageProps {
  companionState: CompanionState;
  expanded: boolean;
  manifest: AvatarManifest | null;
  cameraConfig?: AvatarCameraConfig;
  forcedAnimation?: string | null;
  suggestedAnimation?: DesktopAvatarAnimationKey | null;
  onDragStart: () => void;
  onAnimationsLoaded?: (names: string[]) => void;
  onAnimationDebugChange?: (input: AvatarAnimationDebug) => void;
  onForcedAnimationFinished?: (name: string) => void;
}

type AnimationRef = RefObject<THREE.AnimationAction | null>;

function CameraController({ config, reducedMotion, expanded, animationRef }: { config: AvatarCameraConfig; reducedMotion: boolean; expanded: boolean; animationRef: AnimationRef }) {
  const invalidate = useThree((state) => state.invalidate);
  const camera = useThree((state) => state.camera as THREE.PerspectiveCamera);
  const size = useThree((state) => state.size);
  const targetPosition = useRef(new THREE.Vector3());
  const targetLookAt = useRef(new THREE.Vector3());
  const currentLookAt = useRef(new THREE.Vector3());

  useEffect(() => {
    const pose = resolveAvatarCameraPose(config, size.height, expanded);
    targetPosition.current.set(
      pose.position.x,
      pose.position.y,
      pose.position.z
    );
    targetLookAt.current.set(pose.target.x, pose.target.y, pose.target.z);
    camera.fov = config.fov;
    camera.updateProjectionMatrix();
    if (reducedMotion || !expanded) {
      camera.position.copy(targetPosition.current);
      currentLookAt.current.copy(targetLookAt.current);
      camera.lookAt(targetLookAt.current);
      invalidate();
    }
  }, [
    reducedMotion, invalidate, expanded,
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

  useFrame((_, delta) => {
    if (!expanded) {
      const action = animationRef.current;
      const clip = action?.getClip();
      const pose = resolveAvatarCameraPose(config, size.height, false,
        action && clip ? { name: clip.name, time: action.time, duration: clip.duration } : null, reducedMotion);
      targetPosition.current.set(pose.position.x, pose.position.y, pose.position.z);
      targetLookAt.current.set(pose.target.x, pose.target.y, pose.target.z);
    }
    const target = targetPosition.current;
    if (camera.position.distanceToSquared(target) > 0.000001) {
      camera.position.lerp(target, 1 - Math.exp(-5 * Math.min(delta, 0.1)));
    }
    if (expanded) currentLookAt.current.copy(targetLookAt.current);
    else currentLookAt.current.lerp(targetLookAt.current, 1 - Math.exp(-5 * Math.min(delta, 0.1)));
    camera.lookAt(currentLookAt.current);
  });

  return null;
}

function AvatarRig({
  companionState, manifest, forcedAnimation, suggestedAnimation,
  onLoadError, onAnimationsLoaded, onAnimationDebugChange, onForcedAnimationFinished, animationRef
}: Pick<AvatarStageProps, "companionState" | "manifest" | "forcedAnimation" | "suggestedAnimation" |
  "onAnimationsLoaded" | "onAnimationDebugChange" | "onForcedAnimationFinished"> & {
    onLoadError: (message: string | null) => void;
    animationRef: AnimationRef;
  }) {
  const { runtime, error } = useAvatarRuntime(manifest);
  const reducedMotion = useAvatarReducedMotion();
  const invalidate = useThree((state) => state.invalidate);
  const playback = useMemo(() => runtime ? createAvatarPlayback(runtime) : null, [runtime]);
  const [greetedRuntime, setGreetedRuntime] = useState<typeof runtime>(null);
  useLayoutEffect(() => () => { animationRef.current = null; }, [runtime, animationRef]);
  useEffect(() => () => playback?.dispose(), [playback]);
  useEffect(() => onLoadError(error), [error, onLoadError]);
  useEffect(() => onAnimationsLoaded?.(runtime ? Object.keys(runtime.actions) : []), [runtime, onAnimationsLoaded]);
  useLayoutEffect(() => {
    const greeting = runtime && runtime !== greetedRuntime && !forcedAnimation && runtime.actions["teleport-out"];
    const selectedForcedAnimation = greeting ? "teleport-out" : forcedAnimation;
    // Explicit animation controls take precedence and consume this load's greeting.
    if (runtime && forcedAnimation && runtime !== greetedRuntime) setGreetedRuntime(runtime);
    const selectedClip = playback?.select(
      deriveAnimationCandidates({ companionState, forcedAnimation: selectedForcedAnimation, suggestedAnimation }),
      selectedForcedAnimation, greeting ? () => setGreetedRuntime(runtime) : onForcedAnimationFinished
    ) ?? null;
    animationRef.current = playback?.currentAction ?? null;
    // Evaluate the selected pose before the first visible frame (no bind-pose flash).
    playback?.update(0, reducedMotion);
    invalidate();
    onAnimationDebugChange?.({
      assetKind: runtime?.assetKind ?? null,
      selectedClip,
      resolvedAnimationMapping: runtime?.resolvedAnimationMapping ?? {}
    });
  }, [runtime, playback, greetedRuntime, reducedMotion, invalidate, companionState, forcedAnimation, suggestedAnimation, onForcedAnimationFinished, onAnimationDebugChange, animationRef]);
  useFrame((_, delta) => playback?.update(delta, reducedMotion), -1);
  return runtime
    ? <primitive object={runtime.root} dispose={null} />
    : null;
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
  onAnimationDebugChange,
  onForcedAnimationFinished
}: AvatarStageProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const reducedMotion = useAvatarReducedMotion();
  const visible = useAvatarVisibility();
  const animationRef = useRef<THREE.AnimationAction | null>(null);

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
            frameloop={avatarFrameLoop(visible, reducedMotion)}
            camera={{
              position: [
                cameraConfig.position.x,
                cameraConfig.position.y,
                cameraConfig.position.z
              ],
              fov: cameraConfig.fov
            }}
            dpr={[1, 1.5]}
            gl={{ alpha: true, antialias: true }}
            onCreated={({ scene, gl }) => {
              scene.background = null;
              gl.shadowMap.enabled = false;
            }}
          >
            <CameraController config={cameraConfig} reducedMotion={reducedMotion} expanded={expanded} animationRef={animationRef} />
            <hemisphereLight args={["#fff5e8", "#778ba3", 1.6]} />
            <directionalLight position={[2.4, 4, 2.8]} intensity={2.2} />
            <directionalLight position={[-2, 1.3, 2]} intensity={1.1} color="#dceaff" />
            <group position={[0, -1.05, 0]}>
              <AvatarRig
                animationRef={animationRef}
                companionState={companionState}
                manifest={manifest}
                forcedAnimation={forcedAnimation}
                suggestedAnimation={suggestedAnimation}
                onLoadError={setLoadError}
                onAnimationsLoaded={onAnimationsLoaded}
                onAnimationDebugChange={onAnimationDebugChange}
                onForcedAnimationFinished={onForcedAnimationFinished}
              />
            </group>
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
