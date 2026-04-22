#!/usr/bin/env node
import {
  printValidationSummary,
  validateAvatarBuildArgs
} from "./avatar-build-validation.mjs";

const args = process.argv.slice(2);
while (args[0] === "--") {
  args.shift();
}
const jsonOutput = args.includes("--json");
const validationArgs = args.filter((arg) => arg !== "--json");
const result = validateAvatarBuildArgs(validationArgs);
if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        errors: result.errors,
        warnings: result.warnings,
        resolved: result.resolved,
        extras: result.extras
      },
      null,
      2
    )
  );
} else {
  printValidationSummary(result);
}
process.exit(result.ok ? 0 : 1);
