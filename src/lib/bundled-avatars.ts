import first from "../../public/sample-avatar-manifest.json";
import second from "../../public/sample-avatar-2-manifest.json";
import type { AvatarManifest } from "./contracts";

export type AvatarPreference = "female_avatar_1" | "female_avatar_2";
export const BUNDLED_AVATARS = [first, second].map((manifest) => ({
  id: manifest.displayName as AvatarPreference,
  label: manifest.displayName === "female_avatar_1" ? "Female Avatar 1" : "Female Avatar 2",
  preview: `/avatars/previews/${manifest.displayName}.png`,
  manifest: { ...manifest, animationLibraryUrl: manifest.animationLibraryUrl.replace("./", "/") } satisfies AvatarManifest
}));

export function isAvatarPreference(value: unknown): value is AvatarPreference {
  return BUNDLED_AVATARS.some((avatar) => avatar.id === value);
}
