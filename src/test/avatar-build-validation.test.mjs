import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateAvatarBuildArgs } from "../../tools/avatar-build/avatar-build-validation.mjs";

const tempDirs = [];

function createClipsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "avatar-build-validation-"));
  tempDirs.push(dir);
  for (const file of files) {
    writeFileSync(join(dir, file), "dummy");
  }
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("avatar build validation", () => {
  it("passes with required clips and warns only for optional talking", () => {
    const dir = createClipsDir([
      "idle.fbx",
      "walking.fbx",
      "thinking.fbx",
      "communicating.fbx",
      "coffee-break.fbx",
      "at-phone.fbx",
      "teleport-out.fbx",
      "teleport-in.fbx"
    ]);

    const result = validateAvatarBuildArgs(["--mode", "semi", "--clips-dir", dir]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("Optional talking clip missing");
  });

  it("fails when required clip is missing", () => {
    const dir = createClipsDir([
      "idle.fbx",
      "walking.fbx",
      "thinking.fbx",
      "coffee-break.fbx",
      "at-phone.fbx",
      "teleport-out.fbx",
      "teleport-in.fbx"
    ]);

    const result = validateAvatarBuildArgs(["--mode", "semi", "--clips-dir", dir]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("communicating");
  });
});
