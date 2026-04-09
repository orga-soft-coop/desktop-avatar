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
  position: { x: 0, y: 0.95, z: 4.0 },
  target: { x: 0, y: 0.05, z: 0 },
  fov: 30,
  referenceHeight: 780
};

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
