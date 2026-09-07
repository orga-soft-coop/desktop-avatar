export interface AvatarPropAttachment {
  prop: string;
  bone: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export interface AvatarLibrary {
  version: 2;
  avatar: string;
  model: string;
  rootHeightOffset: number;
  props: Record<string, { url: string }>;
  clips: { name: string; url: string; loop: boolean; props: AvatarPropAttachment[] }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function relativeAsset(value: unknown): value is string {
  return typeof value === "string" && /\.glb$/i.test(value) && !/^(?:[a-z]+:|[\\/])/i.test(value)
    && !value.replaceAll("\\", "/").split("/").includes("..");
}
function finiteVector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && value.every(item => typeof item === "number" && Number.isFinite(item));
}

/** Consume the source project's body/hands/props contract without authoring a second rig. */
export function parseAvatarLibrary(value: unknown): AvatarLibrary {
  if (!record(value) || value.version !== 2 || value.skeleton !== "avatar-body-hands-45" || value.jointCount !== 45
    || typeof value.avatar !== "string" || !value.avatar.trim()
    || !relativeAsset(value.model) || !record(value.props) || !Array.isArray(value.clips) || !value.clips.length
    || (value.rootHeightOffset !== undefined && (typeof value.rootHeightOffset !== "number" || !Number.isFinite(value.rootHeightOffset)))) {
    throw new Error("Invalid avatar library manifest (version 2 body/hands required).");
  }
  const props: AvatarLibrary["props"] = Object.create(null);
  for (const [id, prop] of Object.entries(value.props)) {
    if (!id.trim() || !record(prop) || !relativeAsset(prop.url)) throw new Error("Invalid avatar prop asset.");
    props[id] = { url: prop.url };
  }
  const names = new Set<string>();
  const clips = value.clips.map((clip) => {
    if (!record(clip) || typeof clip.name !== "string" || !clip.name.trim()
      || !relativeAsset(clip.url) || typeof clip.loop !== "boolean" || names.has(clip.name.toLowerCase())
      || (clip.props !== undefined && !Array.isArray(clip.props))) {
      throw new Error("Invalid or duplicate avatar library clip.");
    }
    const attached = new Set<string>();
    const attachments = (clip.props ?? []).map((entry: unknown): AvatarPropAttachment => {
      if (!record(entry) || typeof entry.prop !== "string" || !Object.hasOwn(props, entry.prop) || attached.has(entry.prop)
        || (entry.bone !== "DEF-hand.L" && entry.bone !== "DEF-hand.R")
        || !finiteVector(entry.position, 3) || !finiteVector(entry.quaternion, 4)
        || Math.abs(Math.hypot(...entry.quaternion) - 1) > 0.001
        || !finiteVector(entry.scale, 3) || entry.scale.some(value => value <= 0)) {
        throw new Error("Invalid avatar hand attachment.");
      }
      attached.add(entry.prop);
      return { prop: entry.prop, bone: entry.bone, position: entry.position as AvatarPropAttachment["position"],
        quaternion: entry.quaternion as AvatarPropAttachment["quaternion"], scale: entry.scale as AvatarPropAttachment["scale"] };
    });
    names.add(clip.name.toLowerCase());
    return { name: clip.name, url: clip.url, loop: clip.loop, props: attachments };
  });
  if (!names.has("idle")) throw new Error("Avatar library requires an idle clip.");
  return { version: 2, avatar: value.avatar, model: value.model, rootHeightOffset: value.rootHeightOffset as number ?? 0, props, clips };
}

/** Bundled library assets are relative to their frontend manifest directory. */
export function resolveLibraryAsset(libraryPath: string, relative: string): string {
  return libraryPath.slice(0, libraryPath.lastIndexOf("/") + 1) + relative;
}
