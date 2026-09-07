export interface CameraVector3 {
  x: number;
  y: number;
  z: number;
}

export interface AvatarCameraConfig {
  position: CameraVector3;
  target: CameraVector3;
  fov: number;
  referenceHeight: number;
}

export const DEFAULT_AVATAR_CAMERA_CONFIG: AvatarCameraConfig = {
  position: { x: 0, y: 0, z: 3 },
  target: { x: 0, y: 0, z: 0 },
  fov: 61,
  referenceHeight: 780
};

export interface AvatarCameraAnimation { name: string; time: number; duration: number }

/** Follow the authored wave briefly, then return to the close portrait. */
export function resolveAvatarCameraPose(
  config: AvatarCameraConfig, viewportHeight: number, expanded: boolean,
  animation?: AvatarCameraAnimation | null, reducedMotion = false
) {
  const smooth = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped * clamped * (3 - 2 * clamped);
  };
  const progress = animation && animation.duration > 0 ? animation.time / animation.duration : 0;
  const wave = !expanded && !reducedMotion && animation?.name === "teleport-out"
    ? smooth(progress / 0.16) * (1 - smooth((progress - 0.76) / 0.24)) : 0;
  return {
    position: {
      ...config.position,
      x: config.position.x - wave * 0.18,
      z: config.position.z * (expanded ? viewportHeight / config.referenceHeight : 0.35 + wave * 0.13)
    },
    target: {
      ...config.target,
      x: config.target.x - wave * 0.24,
      y: config.target.y + (expanded ? 0 : 0.12 - wave * 0.17)
    }
  };
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}

export function formatAvatarCameraConfig(config: AvatarCameraConfig): string {
  return [
    "export const DEFAULT_AVATAR_CAMERA_CONFIG = {",
    `  position: { x: ${formatNumber(config.position.x)}, y: ${formatNumber(config.position.y)}, z: ${formatNumber(config.position.z)} },`,
    `  target: { x: ${formatNumber(config.target.x)}, y: ${formatNumber(config.target.y)}, z: ${formatNumber(config.target.z)} },`,
    `  fov: ${formatNumber(config.fov)},`,
    `  referenceHeight: ${formatNumber(config.referenceHeight)}`,
    "} as const;"
  ].join("\n");
}
