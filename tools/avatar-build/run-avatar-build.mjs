#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  printValidationSummary,
  readArgValue,
  validateAvatarBuildArgs
} from "./avatar-build-validation.mjs";

const FALLBACK_BLENDER_BIN = "/Applications/Blender.app/Contents/MacOS/Blender";

function findBlenderBinary() {
  const envBin = process.env.BLENDER_BIN?.trim();
  if (envBin) {
    return envBin;
  }
  if (existsSync(FALLBACK_BLENDER_BIN)) {
    return FALLBACK_BLENDER_BIN;
  }
  return "blender";
}

function removeRunnerOnlyFlags(args) {
  const next = [...args];
  while (next[0] === "--") {
    next.shift();
  }
  for (const flag of ["--desktop-target", "--studio-target"]) {
    const index = next.findIndex((item) => item === flag);
    if (index >= 0) {
      next.splice(index, 2);
    }
  }
  return next;
}

function run() {
  const blenderBin = findBlenderBinary();
  const gpuBackend = process.env.AVATAR_BUILD_GPU_BACKEND?.trim() || "";
  const scriptPath = resolve(
    process.cwd(),
    "tools/avatar-build/blender-avatar-build.py"
  );
  const rawArgs = process.argv.slice(2);
  const desktopTarget = readArgValue(rawArgs, "--desktop-target");
  const studioTarget = readArgValue(rawArgs, "--studio-target");
  const passthroughArgs = removeRunnerOnlyFlags(rawArgs);
  const validation = validateAvatarBuildArgs(passthroughArgs);
  printValidationSummary(validation);
  if (!validation.ok) {
    process.exit(1);
  }
  const mode = readArgValue(passthroughArgs, "--mode");
  const outputGlb = readArgValue(passthroughArgs, "--output-glb");
  const cmdArgs = [
    "--background",
    "--factory-startup",
    "--python",
    scriptPath,
    "--",
    ...passthroughArgs
  ];
  if (gpuBackend) {
    cmdArgs.splice(2, 0, "--gpu-backend", gpuBackend);
  }

  const result = spawnSync(blenderBin, cmdArgs, {
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    console.error(
      `[avatar-build] failed to execute blender binary "${blenderBin}": ${result.error.message}`
    );
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  if (mode === "full" && outputGlb) {
    for (const target of [desktopTarget, studioTarget]) {
      if (!target?.trim()) {
        continue;
      }
      const resolvedTarget = resolve(process.cwd(), target);
      mkdirSync(dirname(resolvedTarget), { recursive: true });
      copyFileSync(resolve(process.cwd(), outputGlb), resolvedTarget);
      console.log(`[avatar-build] copied output GLB to ${resolvedTarget}`);
    }
  }
  process.exit(0);
}

run();
