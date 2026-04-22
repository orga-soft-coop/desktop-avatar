import { loadAvatarAsset } from "./tauri";
import { normalizePackedAnimationMapping } from "./avatar-animation-selection";
import type { PackedAvatarAnimationState } from "./contracts";
import { t } from "./i18n";

export interface LoadedAnimationAsset {
  source: string;
  url: string;
}

export type LoadedAvatarAssets =
  | {
      kind: "legacy-vrm";
      vrmUrl: string;
      idleAnimationUrls: LoadedAnimationAsset[];
      attentionAnimationUrl: LoadedAnimationAsset | null;
      thinkingAnimationUrl: LoadedAnimationAsset | null;
      talkingAnimationUrl: LoadedAnimationAsset | null;
      revoke: () => void;
    }
  | {
      kind: "packed-glb";
      modelUrl: string;
      animationMapping: Partial<Record<PackedAvatarAnimationState, string>>;
      revoke: () => void;
    };

export async function resolveAvatarAssets(manifest: {
  modelUrl?: string | null;
  animationMapping?: Partial<Record<PackedAvatarAnimationState, string>> | null;
  vrmUrl?: string | null;
  idleAnimationUrls?: string[];
  attentionAnimationUrl?: string | null;
  thinkingAnimationUrl?: string | null;
  talkingAnimationUrl?: string | null;
}): Promise<LoadedAvatarAssets> {
  const blobUrls: string[] = [];
  const load = async (path: string): Promise<LoadedAnimationAsset> => {
    const url = await loadAvatarAsset(path);
    if (url.startsWith("blob:")) {
      blobUrls.push(url);
    }
    return {
      source: path,
      url
    };
  };

  const packedModelUrl = manifest.modelUrl?.trim();
  if (packedModelUrl) {
    return {
      kind: "packed-glb",
      modelUrl: (await load(packedModelUrl)).url,
      animationMapping: normalizePackedAnimationMapping(manifest.animationMapping),
      revoke: () => {
        blobUrls.forEach((url) => URL.revokeObjectURL(url));
      }
    };
  }

  const vrmUrl = manifest.vrmUrl?.trim();
  if (!vrmUrl) {
    throw new Error(t("errors.avatarManifestRequiresModel"));
  }

  const idleAnimationSources = manifest.idleAnimationUrls ?? [];
  if (idleAnimationSources.length === 0) {
    throw new Error(t("errors.legacyVrmRequiresIdle"));
  }

  return {
    kind: "legacy-vrm",
    vrmUrl: (await load(vrmUrl)).url,
    idleAnimationUrls: await Promise.all(idleAnimationSources.map(load)),
    attentionAnimationUrl: manifest.attentionAnimationUrl
      ? await load(manifest.attentionAnimationUrl)
      : null,
    thinkingAnimationUrl: manifest.thinkingAnimationUrl
      ? await load(manifest.thinkingAnimationUrl)
      : null,
    talkingAnimationUrl: manifest.talkingAnimationUrl
      ? await load(manifest.talkingAnimationUrl)
      : null,
    revoke: () => {
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    }
  };
}
