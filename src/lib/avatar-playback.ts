import { LoopOnce, LoopRepeat, type AnimationAction } from "three";
import type { AvatarRuntime } from "./avatar-runtime";
import { selectAnimationAction } from "./avatar-animation-selection";

const FADE_SECONDS = 0.24;
const normalize = (name?: string | null) => name?.trim().toLowerCase();
const isExit = (name?: string | null) => ["teleport-out", "teleported-out"].includes(normalize(name) ?? "");

/** One controller per model; aliases and React rerenders never restart the same clip. */
export function createAvatarPlayback(runtime: AvatarRuntime) {
  let current: AnimationAction | undefined;
  let oneShot = false;
  let finished = false;
  let completionName: string | null = null;
  let onFinished: ((name: string) => void) | undefined;
  const retiring = new Map<AnimationAction, number>();

  const finish = (event: { action: AnimationAction }) => {
    if (event.action !== current || !oneShot || finished) return;
    finished = true;
    if (completionName) onFinished?.(completionName);
  };
  let listening = false;

  return {
    get currentAction() { return current; },
    select(candidates: string[], forced?: string | null, callback?: (name: string) => void) {
      if (!listening) {
        runtime.mixer.addEventListener("finished", finish);
        listening = true;
      }
      onFinished = callback;
      const next = selectAnimationAction(runtime.actions, candidates);
      const forcedKey = Object.keys(runtime.actions).find((key) => normalize(key) === normalize(forced));
      // Check the requested alias itself, not the first dictionary entry for this action.
      const forcedExit = isExit(forced) && !!forcedKey && runtime.actions[forcedKey] === next;
      const nextOneShot = forcedExit || (!!next && runtime.actionLoops?.get(next) === false);
      completionName = forcedExit ? forced!.trim() : null;
      if (current === next && oneShot === nextOneShot) return next?.getClip().name ?? null;
      const previous = current;
      if (current) {
        current.stopFading().fadeOut(FADE_SECONDS);
        retiring.set(current, FADE_SECONDS);
      }
      current = next;
      runtime.setActiveAction?.(next);
      oneShot = nextOneShot;
      finished = false;
      if (next) {
        retiring.delete(next);
        next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
        next.clampWhenFinished = oneShot;
        next.setLoop(oneShot ? LoopOnce : LoopRepeat, oneShot ? 1 : Infinity);
        // A new model starts in its selected pose, never briefly in the bind pose.
        if (previous && previous !== next) next.fadeIn(FADE_SECONDS);
        else next.stopFading();
        next.play();
      }
      return next?.getClip().name ?? null;
    },
    update(delta: number, reducedMotion = false) {
      const step = Number.isFinite(delta) ? Math.max(0, Math.min(delta, 0.1)) : 0;
      if (reducedMotion) {
        retiring.forEach((_, action) => action.stop());
        retiring.clear();
        if (current) {
          current.stopFading().setEffectiveWeight(1);
          if (oneShot && !finished) {
            // Complete lifecycle callbacks even when decorative motion is disabled.
            runtime.mixer.update(current.getClip().duration + 0.001);
          } else {
            if (!oneShot) current.time = 0;
            runtime.mixer.update(0);
          }
        }
        return;
      }
      runtime.mixer.update(step);
      retiring.forEach((remaining, action) => {
        if (remaining <= step) {
          action.stop();
          retiring.delete(action);
        } else retiring.set(action, remaining - step);
      });
    },
    dispose() {
      runtime.mixer.removeEventListener("finished", finish);
      listening = false;
      current = undefined;
      runtime.setActiveAction?.();
      runtime.mixer.stopAllAction();
      retiring.clear();
    }
  };
}
