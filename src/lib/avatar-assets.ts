import { normalizeAnimationMapping } from "./avatar-animation-selection";
import type { AvatarManifest, AvatarAnimationState } from "./contracts";
import { parseAvatarLibrary, resolveLibraryAsset, type AvatarLibrary } from "./avatar-library";
import { t } from "./i18n";

export interface LoadedAvatarAssets {
  modelUrl: string;
  clips: AvatarLibrary["clips"];
  props: AvatarLibrary["props"];
  animationMapping: Partial<Record<AvatarAnimationState, string>>;
}

export async function resolveAvatarAssets(manifest: AvatarManifest): Promise<LoadedAvatarAssets> {
  const path = manifest.animationLibraryUrl;
  if (!path || !/^\/avatars\/female_avatar_[12]\/manifest\.json$/.test(path)) {
    throw new Error(t("errors.avatarManifestRequiresModel"));
  }
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Avatar library unavailable (${response.status}).`);
  const library = parseAvatarLibrary(await response.json());
  if (library.avatar !== path.split("/")[2]) throw new Error("Avatar library identity mismatch.");
  return {
    props: Object.fromEntries(Object.entries(library.props).map(([id, prop]) => [id, { url: resolveLibraryAsset(path, prop.url) }])),
    modelUrl: resolveLibraryAsset(path, library.model),
    clips: library.clips.map(clip => ({ ...clip, url: resolveLibraryAsset(path, clip.url) })),
    animationMapping: normalizeAnimationMapping(manifest.animationMapping)
  };
}
