import { describe, expect, it } from "vitest";
import { parseAvatarLibrary, resolveLibraryAsset } from "../lib/avatar-library";

const library = { version: 2, skeleton: "avatar-body-hands-45", jointCount: 45, props: {}, avatar: "female_avatar_1", model: "avatar.glb", rootHeightOffset: .03, clips: [{ name: "idle", url: "animations/idle.glb", loop: true }] };
describe("shared avatar library contract", () => {
  it("accepts canonical metadata and preserves clip loop policy", () => {
    expect(parseAvatarLibrary(library)).toMatchObject({ version: 2, avatar: library.avatar, clips: [{ ...library.clips[0], props: [] }] });
  });
  it.each([
    { ...library, version: 1 },
    { ...library, skeleton: "old-body-33" },
    { ...library, jointCount: 33 },
    { ...library, model: "avatar.vrm" },
    { ...library, clips: [{ name: "idle", url: "idle.fbx", loop: true }] },
    { ...library, rootHeightOffset: Infinity },
    { ...library, clips: [] },
    { ...library, clips: [{ name: "idle", url: "idle.glb", loop: "false" }] },
    { ...library, clips: [...library.clips, ...library.clips] },
    { ...library, model: "../unrelated.glb" },
    { ...library, model: "https://other.example/model.glb" }
  ])("rejects invalid library metadata", (value) => {
    expect(() => parseAvatarLibrary(value)).toThrow();
  });
  it("resolves clip paths against the bundled manifest directory", () => {
    expect(resolveLibraryAsset("/assets/female/manifest.json", "animations/idle.glb")).toBe("/assets/female/animations/idle.glb");
  });
});

const attachment = { prop: "pen", bone: "DEF-hand.R", position: [0, .02, .01], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] };
const withProps = (entry: unknown) => ({ ...library, props: { pen: { url: "props/pen.glb" } }, clips: [{ ...library.clips[0], props: [entry] }] });
it("preserves authored hand transforms", () => {
  expect(parseAvatarLibrary(withProps(attachment)).clips[0].props).toEqual([attachment]);
});
it.each([
  { ...attachment, prop: "unknown" },
  { ...attachment, bone: "DEF-index.01.R" },
  { ...attachment, position: [0, NaN, 0] },
  { ...attachment, quaternion: [0, 0, 0, 0] },
  { ...attachment, quaternion: [0, 1] },
  { ...attachment, scale: [1, 0, 1] }
])("rejects invalid hand attachments", (entry) => {
  expect(() => parseAvatarLibrary(withProps(entry))).toThrow("attachment");
});
it("rejects missing, unsafe and duplicate prop definitions", () => {
  expect(() => parseAvatarLibrary({ ...withProps(attachment), props: {} })).toThrow();
  expect(() => parseAvatarLibrary({ ...withProps(attachment), props: { pen: { url: "../pen.glb" } } })).toThrow();
  expect(() => parseAvatarLibrary({ ...withProps(attachment), clips: [{ ...library.clips[0], props: [attachment, attachment] }] })).toThrow();
});
