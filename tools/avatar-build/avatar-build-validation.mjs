import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_STATES = [
  "idle",
  "walking",
  "working",
  "communicating",
  "coffee-break",
  "at-phone",
  "teleport-out",
  "teleport-in"
];

function normalizeStem(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function readArgValue(args, key) {
  const index = args.findIndex((item) => item === key);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

export function buildClipMapping(args) {
  const workingClip = (readArgValue(args, "--working-clip") ?? "thinking").trim();
  const talkingClip = (readArgValue(args, "--talking-clip") ?? "talking").trim();
  const mapping = {
    idle: "idle",
    walking: "walking",
    working: workingClip,
    communicating: "communicating",
    "coffee-break": "coffee-break",
    "at-phone": "at-phone",
    "teleport-out": "teleport-out",
    "teleport-in": "teleport-in"
  };
  if (talkingClip) {
    mapping.talking = talkingClip;
  }
  return mapping;
}

function resolveClipEntry(files, stem) {
  const direct = files.find((entry) => entry.stem.toLowerCase() === stem.toLowerCase());
  if (direct) {
    return { file: direct.file, confidence: "exact" };
  }

  const normalizedStem = normalizeStem(stem);
  const normalized = files.find((entry) => normalizeStem(entry.stem) === normalizedStem);
  if (normalized) {
    return { file: normalized.file, confidence: "normalized" };
  }
  return null;
}

export function validateAvatarBuildArgs(args) {
  const errors = [];
  const warnings = [];
  const mode = readArgValue(args, "--mode");
  if (mode !== "semi" && mode !== "full") {
    errors.push("Missing or invalid --mode (expected: semi|full).");
  }

  const clipsDirArg = readArgValue(args, "--clips-dir");
  if (!clipsDirArg) {
    errors.push("Missing --clips-dir.");
    return { ok: false, errors, warnings, resolved: {}, extras: [] };
  }

  const clipsDir = resolve(process.cwd(), clipsDirArg);
  if (!existsSync(clipsDir) || !statSync(clipsDir).isDirectory()) {
    errors.push(`clips directory does not exist: ${clipsDir}`);
    return { ok: false, errors, warnings, resolved: {}, extras: [] };
  }

  const files = readdirSync(clipsDir)
    .filter((name) => name.toLowerCase().endsWith(".fbx"))
    .map((file) => ({ file, stem: file.replace(/\.fbx$/i, "") }));
  if (files.length === 0) {
    errors.push(`No .fbx files found in clips directory: ${clipsDir}`);
    return { ok: false, errors, warnings, resolved: {}, extras: [] };
  }

  const mapping = buildClipMapping(args);
  const resolved = {};
  const usedFiles = new Set();

  for (const [state, clipStem] of Object.entries(mapping)) {
    const match = resolveClipEntry(files, clipStem);
    if (!match) {
      if (state === "talking") {
        warnings.push(`Optional talking clip missing: ${clipStem}.fbx`);
        continue;
      }
      errors.push(`Missing required clip for state "${state}": ${clipStem}.fbx`);
      continue;
    }

    resolved[state] = match.file;
    usedFiles.add(match.file);
    if (match.confidence === "normalized") {
      warnings.push(
        `Clip "${clipStem}.fbx" matched by normalized name -> "${match.file}" (check naming consistency).`
      );
    }
  }

  for (const state of REQUIRED_STATES) {
    if (!resolved[state]) {
      errors.push(`Required state unresolved after matching: ${state}`);
    }
  }

  const extras = files.map((entry) => entry.file).filter((file) => !usedFiles.has(file));
  if (extras.length > 0) {
    warnings.push(`Unused clips detected: ${extras.join(", ")}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolved,
    extras
  };
}

export function printValidationSummary(result) {
  if (result.ok) {
    console.log("[avatar-validate] clip validation passed.");
  } else {
    console.error("[avatar-validate] clip validation failed.");
  }

  if (Object.keys(result.resolved).length > 0) {
    console.log("[avatar-validate] resolved mapping:");
    for (const [state, file] of Object.entries(result.resolved)) {
      console.log(`  - ${state} -> ${file}`);
    }
  }

  for (const warning of result.warnings) {
    console.warn(`[avatar-validate] warning: ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`[avatar-validate] error: ${error}`);
  }
}
