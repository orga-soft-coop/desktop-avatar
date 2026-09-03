const SESSION_ERROR_CODES = new Set(["AUTH_SESSION_REQUIRED", "AUTH_SESSION_INVALID"]);

export function agentStudioErrorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "").trim();
    if (code) return code;
  }
  const text = typeof error === "string" ? error : String(error ?? "");
  for (const code of SESSION_ERROR_CODES) {
    if (text.includes(code)) return code;
  }
  return null;
}

function agentStudioErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export function isAgentStudioSessionInvalid(error: unknown): boolean {
  return agentStudioErrorStatus(error) === 401
    || SESSION_ERROR_CODES.has(agentStudioErrorCode(error) ?? "");
}

export function requiresFreshAgentStudioLogin(error: unknown): boolean {
  return isAgentStudioSessionInvalid(error)
    || agentStudioErrorCode(error) === "AUTH_LOGIN_FLOW_INVALID";
}
