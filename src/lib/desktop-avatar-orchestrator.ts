import type {
  CompanionState,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarAnimationKey,
  DesktopAvatarRequestDocument,
  DesktopAvatarRequestStatus,
  DesktopAvatarResponse,
  DesktopAvatarStreamEvent,
  DesktopAvatarWidgetPayload
} from "./contracts";

export interface DesktopAvatarOrchestratorState {
  clientRequestId: string | null;
  avatarRequestId: string | null;
  streamUrl: string | null;
  pollUrl: string | null;
  phase: "idle" | "creating" | "streaming" | "polling" | "completed" | "failed";
  status: DesktopAvatarRequestStatus | null;
  statusMessage: string | null;
  talkText: string;
  widget: DesktopAvatarWidgetPayload | null;
  followUpQuestions: string[];
  error: string | null;
  isDone: boolean;
  hasTalkEvent: boolean;
  companionState: CompanionState;
  animation: DesktopAvatarAnimationKey;
}

export type DesktopAvatarOrchestratorAction =
  | { type: "reset" }
  | { type: "createRequested"; clientRequestId: string }
  | { type: "createAccepted"; result: CreateDesktopAvatarRequestResult }
  | { type: "streamEvent"; event: DesktopAvatarStreamEvent }
  | { type: "pollingStarted" }
  | { type: "pollingSnapshot"; document: DesktopAvatarRequestDocument }
  | { type: "streamDisconnected"; reason?: string | null }
  | { type: "requestFailed"; message: string; status?: DesktopAvatarRequestStatus | null };

export const desktopAvatarInitialState: DesktopAvatarOrchestratorState = {
  clientRequestId: null,
  avatarRequestId: null,
  streamUrl: null,
  pollUrl: null,
  phase: "idle",
  status: null,
  statusMessage: null,
  talkText: "",
  widget: null,
  followUpQuestions: [],
  error: null,
  isDone: false,
  hasTalkEvent: false,
  companionState: "idle",
  animation: "idle"
};

export function isDesktopAvatarTerminalStatus(
  status: DesktopAvatarRequestStatus | null | undefined
): status is Extract<DesktopAvatarRequestStatus, "COMPLETED" | "FAILED" | "NEEDS_CLARIFICATION"> {
  return status === "COMPLETED" || status === "FAILED" || status === "NEEDS_CLARIFICATION";
}

export function isDesktopAvatarThinkingStatus(
  status: DesktopAvatarRequestStatus | null | undefined
): boolean {
  return (
    status === "ROUTING" ||
    status === "THINKING" ||
    status === "FETCHING_DATA" ||
    status === "FORMATTING_RESPONSE"
  );
}

function animationToCompanionState(
  animation: DesktopAvatarAnimationKey,
  hasError: boolean
): CompanionState {
  if (hasError) {
    return "error";
  }

  switch (animation) {
    case "thinking":
      return "thinking";
    case "talking":
      return "speaking";
    case "attention":
      return "listening";
    case "idle":
    default:
      return "idle";
  }
}

export function animationForStatus(
  status: DesktopAvatarRequestStatus | null | undefined
): DesktopAvatarAnimationKey {
  switch (status) {
    case "RECEIVED":
    case "TALK_READY":
    case "WIDGET_READY":
    case "NEEDS_CLARIFICATION":
    case "FAILED":
      return "attention";
    case "ROUTING":
    case "THINKING":
    case "FETCHING_DATA":
    case "FORMATTING_RESPONSE":
      return "thinking";
    case "COMPLETED":
      return "idle";
    default:
      return "thinking";
  }
}

function applyResponse(
  state: DesktopAvatarOrchestratorState,
  response: DesktopAvatarResponse | null | undefined
): DesktopAvatarOrchestratorState {
  if (!response) {
    return state;
  }

  const nextState = {
    ...state,
    talkText: response.talk?.text ?? state.talkText,
    widget: response.widget ?? state.widget,
    followUpQuestions: response.followUpQuestions ?? state.followUpQuestions
  };

  if (response.talk?.text) {
    nextState.hasTalkEvent = true;
  }

  return nextState;
}

export function reduceDesktopAvatarState(
  state: DesktopAvatarOrchestratorState,
  action: DesktopAvatarOrchestratorAction
): DesktopAvatarOrchestratorState {
  switch (action.type) {
    case "reset":
      return desktopAvatarInitialState;

    case "createRequested":
      return {
        ...desktopAvatarInitialState,
        clientRequestId: action.clientRequestId,
        phase: "creating",
        statusMessage: "Sending request…",
        companionState: "thinking",
        animation: "thinking"
      };

    case "createAccepted": {
      const animation = animationForStatus(action.result.status);
      return {
        ...state,
        avatarRequestId: action.result.avatarRequestId,
        streamUrl: action.result.streamUrl,
        pollUrl: action.result.pollUrl,
        status: action.result.status,
        phase: "streaming",
        error: null,
        isDone: false,
        animation,
        companionState: animationToCompanionState(animation, false),
        statusMessage: "Waiting for live updates…"
      };
    }

    case "streamEvent": {
      if (state.avatarRequestId && action.event.avatarRequestId !== state.avatarRequestId) {
        return state;
      }

      switch (action.event.type) {
        case "ready":
          return {
            ...state,
            phase: "streaming",
            statusMessage: state.statusMessage ?? "Connected. Processing request…",
            animation: "thinking",
            companionState: "thinking"
          };

        case "status": {
          const animation = animationForStatus(action.event.status);
          const failed = action.event.status === "FAILED";
          const statusMessage = action.event.message ?? state.statusMessage;
          return {
            ...state,
            status: action.event.status,
            statusMessage,
            phase: isDesktopAvatarTerminalStatus(action.event.status)
              ? failed
                ? "failed"
                : "completed"
              : "streaming",
            error: failed ? statusMessage ?? "Request failed." : null,
            isDone: isDesktopAvatarTerminalStatus(action.event.status),
            animation,
            companionState: animationToCompanionState(animation, failed)
          };
        }

        case "talk":
          return {
            ...state,
            talkText: action.event.talk.text,
            hasTalkEvent: true,
            error: null,
            statusMessage: null,
            animation: "talking",
            companionState: "speaking"
          };

        case "widget": {
          const animation = state.hasTalkEvent ? state.animation : "attention";
          return {
            ...state,
            widget: action.event.widget,
            followUpQuestions:
              action.event.widget.type === "clarification"
                ? action.event.widget.suggestions
                : state.followUpQuestions,
            animation,
            companionState: state.hasTalkEvent
              ? state.companionState
              : animationToCompanionState(animation, false)
          };
        }

        case "done": {
          const animation = action.event.status === "COMPLETED" ? "idle" : animationForStatus(action.event.status);
          return {
            ...state,
            status: action.event.status,
            statusMessage: null,
            isDone: true,
            phase: action.event.status === "FAILED" ? "failed" : "completed",
            animation,
            companionState: animationToCompanionState(animation, action.event.status === "FAILED")
          };
        }

        case "error":
          return {
            ...state,
            error: action.event.error,
            statusMessage: action.event.error,
            status: "FAILED",
            isDone: true,
            phase: "failed",
            animation: "attention",
            companionState: "error"
          };
      }
    }

    case "pollingStarted":
      return {
        ...state,
        phase: "polling",
        statusMessage: state.isDone ? state.statusMessage : "Reconnecting… using polling fallback."
      };

    case "pollingSnapshot": {
      let nextState = applyResponse(state, action.document.response);
      const status = action.document.status;
      const failed = status === "FAILED";
      const animation = nextState.hasTalkEvent && status === "COMPLETED"
        ? "idle"
        : action.document.response?.talk?.text
          ? "talking"
          : action.document.response?.widget
            ? "attention"
            : animationForStatus(status);

      nextState = {
        ...nextState,
        avatarRequestId: nextState.avatarRequestId ?? action.document.avatarRequestId,
        clientRequestId: nextState.clientRequestId ?? action.document.clientRequestId,
        status,
        error: action.document.error ?? (failed ? nextState.error ?? "Request failed." : null),
        isDone: isDesktopAvatarTerminalStatus(status),
        phase: isDesktopAvatarTerminalStatus(status)
          ? failed
            ? "failed"
            : "completed"
          : "polling",
        animation,
        companionState: action.document.response?.talk?.text
          ? "speaking"
          : animationToCompanionState(animation, failed),
        statusMessage: failed
          ? action.document.error ?? nextState.statusMessage ?? "Request failed."
          : isDesktopAvatarTerminalStatus(status)
            ? null
            : nextState.statusMessage
      };

      return nextState;
    }

    case "streamDisconnected":
      if (state.isDone || !state.avatarRequestId) {
        return state;
      }
      return {
        ...state,
        phase: "polling",
        statusMessage: action.reason ?? "Stream disconnected. Switching to polling fallback."
      };

    case "requestFailed": {
      const status = action.status ?? "FAILED";
      return {
        ...state,
        status,
        error: action.message,
        statusMessage: action.message,
        isDone: true,
        phase: "failed",
        animation: "attention",
        companionState: "error"
      };
    }

    default:
      return state;
  }
}
