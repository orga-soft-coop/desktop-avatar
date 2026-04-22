import type {
  CompanionState,
  DesktopAvatarAnimationKey,
  PackedAvatarAnimationState
} from "./contracts";

export function deriveAnimationCandidates(input: {
  forcedAnimation?: string | null;
  suggestedAnimation?: DesktopAvatarAnimationKey | null;
  companionState: CompanionState;
}): string[] {
  if (input.forcedAnimation?.trim()) {
    return [input.forcedAnimation.trim()];
  }

  if (input.suggestedAnimation) {
    switch (input.suggestedAnimation) {
      case "talking":
        return ["talking", "communicating", "idle"];
      case "thinking":
        return ["thinking", "working", "idle"];
      case "attention":
        return ["attention", "communicating", "idle"];
      case "idle":
      default:
        return ["idle"];
    }
  }

  if (input.companionState === "speaking") {
    return ["talking", "communicating", "idle"];
  }

  if (input.companionState === "thinking" || input.companionState === "transcribing") {
    return ["thinking", "working", "idle"];
  }

  if (input.companionState === "listening") {
    return ["attention", "communicating", "idle"];
  }

  return ["idle"];
}

export function normalizePackedAnimationMapping(
  input?: Partial<Record<PackedAvatarAnimationState, string>> | null
): Partial<Record<PackedAvatarAnimationState, string>> {
  if (!input) {
    return {};
  }

  const normalized: Partial<Record<PackedAvatarAnimationState, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    normalized[key as PackedAvatarAnimationState] = trimmed;
  }
  return normalized;
}

export function selectAnimationAction<T>(
  actions: Record<string, T>,
  candidates: string[]
): T | undefined {
  const actionKeys = Object.keys(actions);
  if (actionKeys.length === 0) {
    return undefined;
  }

  const resolveIdle = (): T | undefined => {
    if (actions.idle) {
      return actions.idle;
    }
    for (const key of actionKeys) {
      if (key.toLowerCase().startsWith("idle-")) {
        return actions[key];
      }
    }
    return undefined;
  };

  for (const candidate of candidates) {
    if (candidate === "idle") {
      const idle = resolveIdle();
      if (idle) {
        return idle;
      }
      continue;
    }
    if (actions[candidate]) {
      return actions[candidate];
    }
  }

  return resolveIdle() ?? actions[actionKeys[0]];
}
