import { loadAvatarAsset } from "./tauri";

export interface LoadedAnimationAsset {
  source: string;
  url: string;
}

export interface LoadedAvatarAssets {
  vrmUrl: string;
  idleAnimationUrls: LoadedAnimationAsset[];
  attentionAnimationUrl: LoadedAnimationAsset | null;
  thinkingAnimationUrl: LoadedAnimationAsset | null;
  talkingAnimationUrl: LoadedAnimationAsset | null;
  revoke: () => void;
}

export async function resolveAvatarAssets(manifest: {
  vrmUrl: string;
  idleAnimationUrls: string[];
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

  const vrmUrl = (await load(manifest.vrmUrl)).url;
  const idleAnimationUrls = await Promise.all(manifest.idleAnimationUrls.map(load));
  const attentionAnimationUrl = manifest.attentionAnimationUrl
    ? await load(manifest.attentionAnimationUrl)
    : null;
  const thinkingAnimationUrl = manifest.thinkingAnimationUrl
    ? await load(manifest.thinkingAnimationUrl)
    : null;
  const talkingAnimationUrl = manifest.talkingAnimationUrl
    ? await load(manifest.talkingAnimationUrl)
    : null;

  return {
    vrmUrl,
    idleAnimationUrls,
    attentionAnimationUrl,
    thinkingAnimationUrl,
    talkingAnimationUrl,
    revoke: () => {
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    }
  };
}
