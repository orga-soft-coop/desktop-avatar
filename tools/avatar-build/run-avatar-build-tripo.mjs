#!/usr/bin/env node
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function hasFlag(args, key) {
  return args.some((item) => item === key);
}

function stripLeadingSeparators(args) {
  const next = [...args];
  while (next[0] === "--") {
    next.shift();
  }
  return next;
}

function withDefaultFlag(args, key, value) {
  if (hasFlag(args, key)) {
    return args;
  }
  return [key, value, ...args];
}

function run() {
  const baseArgs = stripLeadingSeparators(process.argv.slice(2));
  const args = withDefaultFlag(baseArgs, "--clip-retarget-profile", "tripo");
  const runnerPath = resolve(process.cwd(), "tools/avatar-build/run-avatar-build.mjs");
  const result = spawnSync(process.execPath, [runnerPath, ...args], {
    stdio: "inherit",
    env: process.env
  });

  if (result.error) {
    console.error(
      `[avatar-build:tripo] failed to execute "${runnerPath}": ${result.error.message}`
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

run();
