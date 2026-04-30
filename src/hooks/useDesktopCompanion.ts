import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AvatarManifest,
  ChatMessage,
  CompanionState,
  CreateDesktopAvatarRequestInput,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DevToolsLatencySnapshot,
  LocalChatMessageInput,
  LocalChatRequest,
  MessageSource,
  PeekMode,
  PeekPosition,
  PromptRoute,
  StreamDeltaPayload,
  StreamEnvelope,
  StreamErrorPayload,
  StreamFinalPayload,
  StreamTextPayload
} from "../lib/contracts";
import { desktopAvatarApiClient, type DesktopAvatarStreamConnection } from "../lib/desktop-avatar-api";
import {
  desktopAvatarInitialState,
  reduceDesktopAvatarState,
  type DesktopAvatarOrchestratorState,
  isDesktopAvatarTerminalStatus
} from "../lib/desktop-avatar-orchestrator";
import { routePrompt } from "../lib/router";
import { t } from "../lib/i18n";
import {
  getBootstrapState,
  listTtsVoices,
  onTrayPeekCollapse,
  onTrayPeekOpen,
  onTrayPeekPositionChanged,
  onStreamEvent,
  onTtsState,
  resizeWindow,
  sendLocalChat,
  setPeekMode,
  setPeekPosition,
  startWindowDragForMode,
  speakText,
  stopSpeaking,
  transcribeAudio
} from "../lib/tauri";
import {
  DEFAULT_SIZE_PRESET,
  type SizePreset,
  getWindowSizesForPreset,
  readStoredSizePreset,
  storeSizePreset
} from "../lib/window-presets";

const TTS_VOICE_STORAGE_KEY = "desktop-avatar.ttsVoice";
const TTS_ENABLED_STORAGE_KEY = "desktop-avatar.ttsEnabled";
const PEEK_MODE_STORAGE_KEY = "desktop-avatar.peekMode";
const PEEK_POSITION_STORAGE_KEY = "desktop-avatar.peekPosition";
const PEEK_ANIMATION_ENABLED_STORAGE_KEY = "desktop-avatar.peekAnimationEnabled";
const LAST_EXPANDED_SIZE_STORAGE_KEY = "desktop-avatar.lastExpandedSize";
const LOCAL_CHAT_SYSTEM_PROMPT = t("localChat.systemPrompt");
const LOCAL_CHAT_FALLBACK_RESPONSE = t("status.localFallback");
const DEFAULT_PEEK_MODE: PeekMode = "peek";
const DEFAULT_PEEK_POSITION: PeekPosition = "top-right";
const MODE_TRANSITION_COLLAPSE_OUT_MS = 210;
const MODE_TRANSITION_EXPAND_REVEAL_MS = 240;
const MODE_TRANSITION_PEEK_REVEAL_MS = 220;
const MODE_TRANSITION_PEEK_OUT_MS = 190;

type ModeTransitionPhase =
  | "idle"
  | "collapse-out"
  | "peek-out"
  | "peek-in"
  | "expand-prep"
  | "expand-in";

interface SubmissionContext {
  prompt: string;
  source: MessageSource;
  route: PromptRoute;
  clientRequestId?: string;
}

interface ActiveDesktopAvatarRequest extends SubmissionContext {
  assistantMessageId: string;
  avatarRequestId: string | null;
  clientRequestId: string;
}

interface LatencyTimeline {
  requestKey: string;
  requestKind: "desktop-avatar" | "local-chat";
  route: PromptRoute;
  source: MessageSource;
  status: string | null;
  startedAtMs: number;
  startedAt: string;
  usedPolling: boolean;
  createAcceptedAtMs?: number;
  streamConnectedAtMs?: number;
  firstEventAtMs?: number;
  firstResponseAtMs?: number;
  talkAtMs?: number;
  widgetAtMs?: number;
  pollingStartedAtMs?: number;
  completedAtMs?: number;
  failedAtMs?: number;
  ttsRequestedAtMs?: number;
  ttsStartedAtMs?: number;
  ttsEndedAtMs?: number;
  ttsProvider: string | null;
  ttsFallbackUsed: boolean | null;
  lastError: string | null;
  clientRequestId: string | null;
  avatarRequestId: string | null;
  ttsRequestId: string | null;
}

function buildAssistantPlaceholder(source: MessageSource, clientRequestId?: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    source,
    isStreaming: true,
    clientRequestId: clientRequestId ?? null,
    requestStatus: null,
    avatarRequestId: null,
    widget: null,
    followUpQuestions: []
  };
}

function buildUserMessage(text: string, source: MessageSource): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text,
    createdAt: new Date().toISOString(),
    source
  };
}

function buildLocalHistory(messages: ChatMessage[]): LocalChatMessageInput[] {
  const history = messages
    .filter((message) => message.role !== "system" && message.text.trim())
    .map<LocalChatMessageInput>((message) => ({
      role: message.role,
      content: message.text
    }));

  return [
    {
      role: "system",
      content: LOCAL_CHAT_SYSTEM_PROMPT
    },
    ...history
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeLocalAssistantText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  let sanitized = value.trim();
  if (!sanitized) {
    return "";
  }

  const fullPromptPattern = new RegExp(escapeRegExp(LOCAL_CHAT_SYSTEM_PROMPT), "gi");
  sanitized = sanitized.replace(fullPromptPattern, "").trim();

  const prefixPattern =
    /^you are milk,\s*a concise desktop companion\.[\s\S]{0,260}?(?:instructions?\.?|facts\.?)/i;
  sanitized = sanitized.replace(prefixPattern, "").trim();

  return sanitized;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function preferredMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return options.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function buildDesktopAvatarRequestInput(
  prompt: string,
  source: MessageSource,
  clientRequestId: string
): CreateDesktopAvatarRequestInput {
  return {
    clientRequestId,
    requestedBy: "desktop-avatar",
    mode: "SIMULATION",
    modality: source === "voice" ? "voice" : "chat",
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utterance: prompt,
    responseModes: ["talk", "widget"],
    autoStart: true
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown };
    if (typeof candidate.message === "string" && candidate.message.trim().length > 0) {
      return candidate.message;
    }
  }
  return fallback;
}

function isUnsupportedNoMatchErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unsupported") ||
    normalized.includes("no-match") ||
    normalized.includes("no match") ||
    normalized.includes("no active studio agents support") ||
    normalized.includes("does not support required actions") ||
    normalized.includes("ops routing found no active domain target supporting") ||
    normalized.includes("no active studio agents available for desktop avatar routing") ||
    normalized.includes("studio agent is not active and cannot be routed") ||
    normalized.includes("studio agent not found")
  );
}

function nextPollDelay(attempt: number): number {
  if (attempt <= 0) {
    return 500;
  }
  if (attempt === 1) {
    return 1000;
  }
  return 2000;
}

function waitMs(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function readStoredTtsVoice(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(TTS_VOICE_STORAGE_KEY);
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readStoredTtsEnabled(): boolean | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const value = window.localStorage.getItem(TTS_ENABLED_STORAGE_KEY);
    if (!value) {
      return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function storeTtsVoice(voice: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!voice) {
      window.localStorage.removeItem(TTS_VOICE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TTS_VOICE_STORAGE_KEY, voice);
  } catch {
    // no-op (storage can fail in restricted environments)
  }
}

function storeTtsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(TTS_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // no-op (storage can fail in restricted environments)
  }
}

function isPeekMode(value: string | null): value is PeekMode {
  return value === "peek" || value === "expanded";
}

function isPeekPosition(value: string | null): value is PeekPosition {
  return (
    value === "top-left" ||
    value === "top-right" ||
    value === "bottom-left" ||
    value === "bottom-right"
  );
}

function readStoredPeekMode(): PeekMode {
  if (typeof window === "undefined") {
    return DEFAULT_PEEK_MODE;
  }
  try {
    // Startup must always begin in peek mode; the stored value is only
    // retained for compatibility and can still be updated at runtime.
    const raw = window.localStorage.getItem(PEEK_MODE_STORAGE_KEY);
    if (isPeekMode(raw) && raw === DEFAULT_PEEK_MODE) {
      return raw;
    }
    return DEFAULT_PEEK_MODE;
  } catch {
    return DEFAULT_PEEK_MODE;
  }
}

function storePeekMode(mode: PeekMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PEEK_MODE_STORAGE_KEY, mode);
  } catch {
    // no-op
  }
}

function readStoredPeekPosition(): PeekPosition {
  if (typeof window === "undefined") {
    return DEFAULT_PEEK_POSITION;
  }
  try {
    const raw = window.localStorage.getItem(PEEK_POSITION_STORAGE_KEY);
    return isPeekPosition(raw) ? raw : DEFAULT_PEEK_POSITION;
  } catch {
    return DEFAULT_PEEK_POSITION;
  }
}

function storePeekPosition(position: PeekPosition): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PEEK_POSITION_STORAGE_KEY, position);
  } catch {
    // no-op
  }
}

function readStoredAnimationEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(PEEK_ANIMATION_ENABLED_STORAGE_KEY);
    return raw?.trim().toLowerCase() !== "false";
  } catch {
    return true;
  }
}

function storeAnimationEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PEEK_ANIMATION_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // no-op
  }
}

function readStoredLastExpandedHeight(fallbackHeight: number): number {
  if (typeof window === "undefined") {
    return fallbackHeight;
  }
  try {
    const raw = window.localStorage.getItem(LAST_EXPANDED_SIZE_STORAGE_KEY);
    if (!raw) {
      return fallbackHeight;
    }
    const parsed = JSON.parse(raw) as { width?: number; height?: number };
    if (typeof parsed.height === "number" && Number.isFinite(parsed.height)) {
      return Math.max(420, Math.round(parsed.height));
    }
    return fallbackHeight;
  } catch {
    return fallbackHeight;
  }
}

function storeLastExpandedSize(width: number, height: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      LAST_EXPANDED_SIZE_STORAGE_KEY,
      JSON.stringify({ width: Math.round(width), height: Math.round(height) })
    );
  } catch {
    // no-op
  }
}

function elapsed(startedAtMs: number, timestamp?: number): number | null {
  if (typeof timestamp !== "number") {
    return null;
  }
  return Math.max(0, Math.round(timestamp - startedAtMs));
}

function duration(from?: number, to?: number): number | null {
  if (typeof from !== "number" || typeof to !== "number") {
    return null;
  }
  return Math.max(0, Math.round(to - from));
}

function toLatencySnapshot(timeline: LatencyTimeline): DevToolsLatencySnapshot {
  return {
    requestKey: timeline.requestKey,
    requestKind: timeline.requestKind,
    route: timeline.route,
    source: timeline.source,
    status: timeline.status,
    startedAt: timeline.startedAt,
    usedPolling: timeline.usedPolling,
    createAcceptedMs: elapsed(timeline.startedAtMs, timeline.createAcceptedAtMs),
    streamConnectedMs: elapsed(timeline.startedAtMs, timeline.streamConnectedAtMs),
    firstEventMs: elapsed(timeline.startedAtMs, timeline.firstEventAtMs),
    firstResponseMs: elapsed(timeline.startedAtMs, timeline.firstResponseAtMs),
    talkMs: elapsed(timeline.startedAtMs, timeline.talkAtMs),
    widgetMs: elapsed(timeline.startedAtMs, timeline.widgetAtMs),
    pollFallbackMs: elapsed(timeline.startedAtMs, timeline.pollingStartedAtMs),
    completedMs: elapsed(timeline.startedAtMs, timeline.completedAtMs),
    failedMs: elapsed(timeline.startedAtMs, timeline.failedAtMs),
    ttsRequestedMs: elapsed(timeline.startedAtMs, timeline.ttsRequestedAtMs),
    ttsStartedMs: elapsed(timeline.startedAtMs, timeline.ttsStartedAtMs),
    ttsSpeakDurationMs: duration(timeline.ttsStartedAtMs, timeline.ttsEndedAtMs),
    talkToTtsStartMs: duration(timeline.talkAtMs, timeline.ttsStartedAtMs),
    ttsProvider: timeline.ttsProvider,
    ttsFallbackUsed: timeline.ttsFallbackUsed,
    lastError: timeline.lastError,
    clientRequestId: timeline.clientRequestId,
    avatarRequestId: timeline.avatarRequestId,
    ttsRequestId: timeline.ttsRequestId
  };
}

export function useDesktopCompanion() {
  const [avatarManifest, setAvatarManifest] = useState<AvatarManifest | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peekMode, setPeekModeState] = useState<PeekMode>(() => readStoredPeekMode());
  const [peekPosition, setPeekPositionState] = useState<PeekPosition>(() => readStoredPeekPosition());
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const [modeTransitionPhase, setModeTransitionPhase] = useState<ModeTransitionPhase>("idle");
  const [animationEnabled] = useState<boolean>(() => readStoredAnimationEnabled());
  const [ttsEnabled, setTtsEnabled] = useState(() => readStoredTtsEnabled() ?? true);
  const [ttsVoices, setTtsVoices] = useState<string[]>([]);
  const [selectedTtsVoice, setSelectedTtsVoiceState] = useState<string | null>(() =>
    readStoredTtsVoice()
  );
  const [sizePreset, setSizePresetState] = useState<SizePreset>(() => readStoredSizePreset());
  const [windowSize, setWindowSize] = useState(() => {
    const preset = getWindowSizesForPreset(DEFAULT_SIZE_PRESET);
    return {
      width: preset.expanded.width,
      height: readStoredLastExpandedHeight(preset.expanded.height)
    };
  });
  const [isRecording, setIsRecording] = useState(false);
  const [desktopAvatarState, desktopAvatarDispatch] = useReducer(
    reduceDesktopAvatarState,
    desktopAvatarInitialState
  );
  const [latencyTimeline, setLatencyTimeline] = useState<LatencyTimeline | null>(null);

  const requestContextsRef = useRef(new Map<string, SubmissionContext>());
  const messagesRef = useRef<ChatMessage[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastSubmissionRef = useRef<SubmissionContext | null>(null);
  const activeLocalRequestIdRef = useRef<string | null>(null);
  const activeDesktopAvatarRequestRef = useRef<ActiveDesktopAvatarRequest | null>(null);
  const desktopAvatarStateRef = useRef<DesktopAvatarOrchestratorState>(desktopAvatarInitialState);
  const desktopAvatarConnectionRef = useRef<DesktopAvatarStreamConnection | null>(null);
  const desktopAvatarPollTimeoutRef = useRef<number | null>(null);
  const desktopAvatarPollAttemptRef = useRef(0);
  const desktopAvatarPollErrorCountRef = useRef(0);
  const lastSpokenDesktopAvatarKeyRef = useRef<string | null>(null);
  const isTtsSpeakingRef = useRef(false);
  const peekModeRef = useRef<PeekMode>(peekMode);
  const applyPeekModeRef = useRef<(mode: PeekMode) => Promise<void>>(async () => {});

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    desktopAvatarStateRef.current = desktopAvatarState;
  }, [desktopAvatarState]);

  useEffect(() => {
    peekModeRef.current = peekMode;
  }, [peekMode]);

  const patchLatencyByRequestKey = useCallback(
    (requestKey: string, updater: (current: LatencyTimeline) => LatencyTimeline) => {
      setLatencyTimeline((current) => {
        if (!current || current.requestKey !== requestKey) {
          return current;
        }
        return updater(current);
      });
    },
    []
  );

  const applyPeekPosition = useCallback(async (position: PeekPosition) => {
    setPeekPositionState(position);
    storePeekPosition(position);
    await setPeekPosition(position);
  }, []);

  const applyPeekMode = useCallback(
    async (mode: PeekMode, options?: { animate?: boolean }) => {
      const presetSizes = getWindowSizesForPreset(sizePreset);
      const expandedWidth = presetSizes.expanded.width;
      const collapsedWidth = presetSizes.collapsed.width;
      const collapsedHeight = presetSizes.collapsed.height;
      const expandedHeight =
        mode === "expanded"
          ? Math.max(presetSizes.expanded.height, windowSize.height)
          : Math.max(presetSizes.expanded.height, readStoredLastExpandedHeight(windowSize.height));
      const shouldAnimate = options?.animate ?? animationEnabled;

      const clearTransition = () => {
        requestAnimationFrame(() => {
          setModeTransitionPhase("idle");
          setIsModeTransitioning(false);
        });
      };

      if (shouldAnimate && mode === "peek") {
        setModeTransitionPhase("collapse-out");
        setIsModeTransitioning(true);
        await waitMs(MODE_TRANSITION_COLLAPSE_OUT_MS);
      } else if (shouldAnimate) {
        setModeTransitionPhase("peek-out");
        setIsModeTransitioning(true);
        await waitMs(MODE_TRANSITION_PEEK_OUT_MS);
        setModeTransitionPhase("expand-prep");
      }

      try {
        await setPeekMode(
          mode,
          expandedWidth,
          expandedHeight,
          collapsedWidth,
          collapsedHeight,
          shouldAnimate
        );
        setPeekModeState(mode);
        storePeekMode(mode);
        if (mode === "expanded") {
          const nextSize = { width: expandedWidth, height: expandedHeight };
          setWindowSize(nextSize);
          storeLastExpandedSize(nextSize.width, nextSize.height);
        }

        if (shouldAnimate) {
          if (mode === "peek") {
            setModeTransitionPhase("peek-in");
            setIsModeTransitioning(true);
            await waitMs(MODE_TRANSITION_PEEK_REVEAL_MS);
          } else {
            setModeTransitionPhase("expand-in");
            setIsModeTransitioning(true);
            await waitMs(MODE_TRANSITION_EXPAND_REVEAL_MS);
          }
        }
      } finally {
        if (shouldAnimate) {
          clearTransition();
        }
      }
    },
    [animationEnabled, sizePreset, windowSize.height]
  );

  useEffect(() => {
    applyPeekModeRef.current = (mode: PeekMode) => applyPeekMode(mode);
  }, [applyPeekMode]);

  const markDesktopStreamEvent = useCallback(
    (event: DesktopAvatarStreamEvent) => {
      const activeRequest = activeDesktopAvatarRequestRef.current;
      if (!activeRequest) {
        return;
      }

      const requestKey = activeRequest.clientRequestId;
      const now = Date.now();
      patchLatencyByRequestKey(requestKey, (current) => {
        const next: LatencyTimeline = {
          ...current,
          firstEventAtMs: current.firstEventAtMs ?? now,
          status: event.type === "status" ? event.status : current.status,
          avatarRequestId: current.avatarRequestId ?? activeRequest.avatarRequestId ?? null
        };

        if (event.type === "status" && event.status === "FAILED") {
          next.failedAtMs = current.failedAtMs ?? now;
          next.lastError = event.message ?? current.lastError;
        } else if (event.type === "talk") {
          next.firstResponseAtMs = current.firstResponseAtMs ?? now;
          next.talkAtMs = current.talkAtMs ?? now;
        } else if (event.type === "widget") {
          next.firstResponseAtMs = current.firstResponseAtMs ?? now;
          next.widgetAtMs = current.widgetAtMs ?? now;
        } else if (event.type === "done") {
          if (event.status === "FAILED") {
            next.failedAtMs = current.failedAtMs ?? now;
          } else {
            next.completedAtMs = current.completedAtMs ?? now;
          }
          next.status = event.status;
        } else if (event.type === "error") {
          next.failedAtMs = current.failedAtMs ?? now;
          next.status = "FAILED";
          next.lastError = event.error;
        }

        return next;
      });
    },
    [patchLatencyByRequestKey]
  );

  const markDesktopPollingStarted = useCallback(
    (requestKey: string) => {
      const now = Date.now();
      patchLatencyByRequestKey(requestKey, (current) => ({
        ...current,
        usedPolling: true,
        pollingStartedAtMs: current.pollingStartedAtMs ?? now
      }));
    },
    [patchLatencyByRequestKey]
  );

  const markDesktopPollingSnapshot = useCallback(
    (requestKey: string, document: DesktopAvatarRequestDocument) => {
      const now = Date.now();
      patchLatencyByRequestKey(requestKey, (current) => {
        const next: LatencyTimeline = {
          ...current,
          firstEventAtMs: current.firstEventAtMs ?? now,
          status: document.status,
          avatarRequestId: current.avatarRequestId ?? document.avatarRequestId ?? null
        };

        if (document.response?.talk?.text) {
          next.firstResponseAtMs = current.firstResponseAtMs ?? now;
          next.talkAtMs = current.talkAtMs ?? now;
        }

        if (document.response?.widget) {
          next.firstResponseAtMs = next.firstResponseAtMs ?? now;
          next.widgetAtMs = current.widgetAtMs ?? now;
        }

        if (document.status === "FAILED") {
          next.failedAtMs = current.failedAtMs ?? now;
          next.lastError = document.error ?? current.lastError;
        } else if (isDesktopAvatarTerminalStatus(document.status)) {
          next.completedAtMs = current.completedAtMs ?? now;
        }

        return next;
      });
    },
    [patchLatencyByRequestKey]
  );

  const markLocalStreamEvent = useCallback(
    (event: StreamEnvelope) => {
      const now = Date.now();
      patchLatencyByRequestKey(event.requestId, (current) => {
        const next: LatencyTimeline = {
          ...current,
          firstEventAtMs: current.firstEventAtMs ?? now,
          status: event.kind
        };

        if (event.kind === "final") {
          next.firstResponseAtMs = current.firstResponseAtMs ?? now;
          next.talkAtMs = current.talkAtMs ?? now;
          next.completedAtMs = current.completedAtMs ?? now;
        } else if (event.kind === "error") {
          const payload = event.payload as StreamErrorPayload;
          next.failedAtMs = current.failedAtMs ?? now;
          next.lastError = payload.message;
        }

        return next;
      });
    },
    [patchLatencyByRequestKey]
  );

  const syncDesktopAvatarMessage = useCallback((state: DesktopAvatarOrchestratorState) => {
    const activeRequest = activeDesktopAvatarRequestRef.current;
    if (!activeRequest) {
      return;
    }

    setMessages((current) =>
      current.map((message) => {
        if (message.id !== activeRequest.assistantMessageId) {
          return message;
        }

        return {
          ...message,
          text: state.talkText || state.error || message.text,
          widget: state.widget,
          followUpQuestions: state.followUpQuestions,
          isStreaming: !state.isDone,
          requestStatus: state.status,
          avatarRequestId: activeRequest.avatarRequestId,
          clientRequestId: activeRequest.clientRequestId
        };
      })
    );
  }, []);

  const clearDesktopAvatarPolling = useCallback(() => {
    if (desktopAvatarPollTimeoutRef.current !== null) {
      window.clearTimeout(desktopAvatarPollTimeoutRef.current);
      desktopAvatarPollTimeoutRef.current = null;
    }
  }, []);

  const closeDesktopAvatarConnection = useCallback(async () => {
    const connection = desktopAvatarConnectionRef.current;
    desktopAvatarConnectionRef.current = null;
    if (connection) {
      await connection.close();
    }
  }, []);

  const startDesktopAvatarPolling = useCallback(
    (avatarRequestId: string, pollUrl: string) => {
      clearDesktopAvatarPolling();
      desktopAvatarPollAttemptRef.current = 0;
      desktopAvatarPollErrorCountRef.current = 0;
      desktopAvatarDispatch({ type: "pollingStarted" });
      const activeRequest = activeDesktopAvatarRequestRef.current;
      if (activeRequest && activeRequest.avatarRequestId === avatarRequestId) {
        markDesktopPollingStarted(activeRequest.clientRequestId);
      }

      const poll = async () => {
        const activeRequest = activeDesktopAvatarRequestRef.current;
        if (!activeRequest || activeRequest.avatarRequestId !== avatarRequestId) {
          return;
        }

        try {
          const document = await desktopAvatarApiClient.getRequest({ avatarRequestId, pollUrl });
          desktopAvatarPollErrorCountRef.current = 0;
          markDesktopPollingSnapshot(activeRequest.clientRequestId, document);
          desktopAvatarDispatch({ type: "pollingSnapshot", document });
          if (isDesktopAvatarTerminalStatus(document.status)) {
            clearDesktopAvatarPolling();
            return;
          }
        } catch (caughtError) {
          desktopAvatarPollErrorCountRef.current += 1;
          const message =
            caughtError instanceof Error
              ? caughtError.message
              : t("status.pollingFallbackFailed");
          if (desktopAvatarPollErrorCountRef.current >= 3) {
            patchLatencyByRequestKey(activeRequest.clientRequestId, (current) => ({
              ...current,
              status: "FAILED",
              failedAtMs: current.failedAtMs ?? Date.now(),
              lastError: message
            }));
            desktopAvatarDispatch({ type: "requestFailed", message });
            clearDesktopAvatarPolling();
            return;
          }
          desktopAvatarDispatch({ type: "streamDisconnected", reason: message });
        }

        const delay = nextPollDelay(desktopAvatarPollAttemptRef.current);
        desktopAvatarPollAttemptRef.current += 1;
        desktopAvatarPollTimeoutRef.current = window.setTimeout(() => {
          void poll();
        }, delay);
      };

      void poll();
    },
    [
      clearDesktopAvatarPolling,
      markDesktopPollingSnapshot,
      markDesktopPollingStarted,
      patchLatencyByRequestKey
    ]
  );

  const cleanupDesktopAvatarRuntime = useCallback(async () => {
    clearDesktopAvatarPolling();
    await closeDesktopAvatarConnection();
  }, [clearDesktopAvatarPolling, closeDesktopAvatarConnection]);

  const connectDesktopAvatarStream = useCallback(
    async (avatarRequestId: string, streamUrl: string, pollUrl: string) => {
      await closeDesktopAvatarConnection();
      clearDesktopAvatarPolling();
      desktopAvatarConnectionRef.current = await desktopAvatarApiClient.connectStream({
        avatarRequestId,
        streamUrl,
        onEvent: (event) => {
          markDesktopStreamEvent(event);
          desktopAvatarDispatch({ type: "streamEvent", event });
        },
        onDisconnect: (event) => {
          if (event.phase === "aborted") {
            return;
          }
          desktopAvatarDispatch({ type: "streamDisconnected", reason: event.reason });
          startDesktopAvatarPolling(avatarRequestId, pollUrl);
        }
      });
      const activeRequest = activeDesktopAvatarRequestRef.current;
      if (activeRequest && activeRequest.avatarRequestId === avatarRequestId) {
        patchLatencyByRequestKey(activeRequest.clientRequestId, (current) => ({
          ...current,
          avatarRequestId,
          streamConnectedAtMs: current.streamConnectedAtMs ?? Date.now()
        }));
      }
    },
    [
      clearDesktopAvatarPolling,
      closeDesktopAvatarConnection,
      markDesktopStreamEvent,
      patchLatencyByRequestKey,
      startDesktopAvatarPolling
    ]
  );

  useEffect(() => {
    let unlistenStream: (() => void) | undefined;
    let unlistenTts: (() => void) | undefined;
    let unlistenTrayPeekOpen: (() => void) | undefined;
    let unlistenTrayPeekCollapse: (() => void) | undefined;
    let unlistenTrayPeekPositionChanged: (() => void) | undefined;

    void (async () => {
      const bootstrap = await getBootstrapState();
      setAvatarManifest(bootstrap.avatarManifest);
      setTtsEnabled(() => {
        const stored = readStoredTtsEnabled();
        const next = bootstrap.ttsEnabled ? stored ?? true : false;
        storeTtsEnabled(next);
        return next;
      });
      const presetSizes = getWindowSizesForPreset(sizePreset);
      const expandedHeight = Math.max(
        presetSizes.expanded.height,
        readStoredLastExpandedHeight(presetSizes.expanded.height)
      );
      setWindowSize({ width: presetSizes.expanded.width, height: expandedHeight });
      await setPeekPosition(peekPosition);
      await setPeekMode(
        peekMode,
        presetSizes.expanded.width,
        expandedHeight,
        presetSizes.collapsed.width,
        presetSizes.collapsed.height,
        false
      );

      try {
        const voices = await listTtsVoices();
        const normalized = [...new Set(voices.map((voice) => voice.trim()).filter(Boolean))];
        setTtsVoices(normalized);
        setSelectedTtsVoiceState((current) => {
          const nextVoice = current && normalized.includes(current) ? current : null;
          storeTtsVoice(nextVoice);
          return nextVoice;
        });
      } catch {
        setTtsVoices([]);
      }
    })();

    void onStreamEvent((event) => {
      void handleLocalStreamEvent(event);
    }).then((unlisten) => {
      unlistenStream = unlisten;
    });

    void onTtsState((event) => {
      setLatencyTimeline((current) => {
        if (!current || current.ttsRequestId !== event.requestId) {
          return current;
        }
        const now = Date.now();
        const nextProvider = event.provider?.trim() || null;
        const nextFallback =
          typeof event.fallback === "boolean" ? event.fallback : null;
        if (event.speaking) {
          return {
            ...current,
            ttsStartedAtMs: current.ttsStartedAtMs ?? now,
            ttsProvider: nextProvider ?? current.ttsProvider,
            ttsFallbackUsed: nextFallback ?? current.ttsFallbackUsed
          };
        }
        return {
          ...current,
          ttsEndedAtMs:
            typeof current.ttsStartedAtMs === "number" && !current.ttsEndedAtMs
              ? now
              : current.ttsEndedAtMs,
          ttsProvider: nextProvider ?? current.ttsProvider,
          ttsFallbackUsed: nextFallback ?? current.ttsFallbackUsed
        };
      });
      isTtsSpeakingRef.current = event.speaking;
      if (event.speaking) {
        setCompanionState("speaking");
        return;
      }

      if (activeDesktopAvatarRequestRef.current) {
        setCompanionState(desktopAvatarStateRef.current.companionState);
      } else if (!activeLocalRequestIdRef.current) {
        setCompanionState("idle");
        setStatus(null);
      }
    }).then((unlisten) => {
      unlistenTts = unlisten;
    });

    void onTrayPeekOpen(() => {
      void applyPeekModeRef.current("expanded");
    }).then((unlisten) => {
      unlistenTrayPeekOpen = unlisten;
    });

    void onTrayPeekCollapse(() => {
      void applyPeekModeRef.current("peek");
    }).then((unlisten) => {
      unlistenTrayPeekCollapse = unlisten;
    });

    void onTrayPeekPositionChanged((position) => {
      setPeekPositionState(position);
      storePeekPosition(position);
      if (peekModeRef.current === "peek") {
        void setPeekPosition(position);
      }
    }).then((unlisten) => {
      unlistenTrayPeekPositionChanged = unlisten;
    });

    return () => {
      unlistenStream?.();
      unlistenTts?.();
      unlistenTrayPeekOpen?.();
      unlistenTrayPeekCollapse?.();
      unlistenTrayPeekPositionChanged?.();
      void cleanupDesktopAvatarRuntime();
    };
  }, [cleanupDesktopAvatarRuntime]);

  useEffect(() => {
    if (!activeDesktopAvatarRequestRef.current) {
      return;
    }

    syncDesktopAvatarMessage(desktopAvatarState);
    setStatus(desktopAvatarState.error ?? desktopAvatarState.statusMessage);
    setError(desktopAvatarState.error);
    if (!isTtsSpeakingRef.current) {
      setCompanionState(desktopAvatarState.companionState);
    }
  }, [desktopAvatarState, syncDesktopAvatarMessage]);

  useEffect(() => {
    const activeRequest = activeDesktopAvatarRequestRef.current;
    if (!activeRequest) {
      return;
    }

    if (!desktopAvatarState.talkText.trim()) {
      return;
    }

    const speakKey = `${activeRequest.avatarRequestId}:${desktopAvatarState.talkText}`;
    if (lastSpokenDesktopAvatarKeyRef.current === speakKey) {
      return;
    }
    lastSpokenDesktopAvatarKeyRef.current = speakKey;

    if (ttsEnabled && activeRequest.avatarRequestId) {
      const requestedAtMs = Date.now();
      patchLatencyByRequestKey(activeRequest.clientRequestId, (current) => ({
        ...current,
        ttsRequestId: activeRequest.avatarRequestId,
        ttsRequestedAtMs: current.ttsRequestedAtMs ?? requestedAtMs
      }));
      void speakText(activeRequest.avatarRequestId, desktopAvatarState.talkText, selectedTtsVoice);
    }
  }, [desktopAvatarState.talkText, patchLatencyByRequestKey, selectedTtsVoice, ttsEnabled]);

  useEffect(() => {
    if (!activeDesktopAvatarRequestRef.current || !desktopAvatarState.isDone) {
      return;
    }

    void closeDesktopAvatarConnection();
    clearDesktopAvatarPolling();

    if (!ttsEnabled || !desktopAvatarState.talkText.trim()) {
      setCompanionState(desktopAvatarState.companionState);
    }
  }, [
    clearDesktopAvatarPolling,
    closeDesktopAvatarConnection,
    desktopAvatarState.companionState,
    desktopAvatarState.isDone,
    desktopAvatarState.talkText,
    ttsEnabled
  ]);

  async function handleLocalStreamEvent(event: StreamEnvelope) {
    activeLocalRequestIdRef.current = event.requestId;
    markLocalStreamEvent(event);

    if (event.kind === "handoff_local") {
      const context = requestContextsRef.current.get(event.requestId);
      if (!context) {
        return;
      }

      setStatus(t("status.continuingLocally"));
      void sendLocalChat({
        requestId: event.requestId,
        prompt: context.prompt,
        messages: buildLocalHistory(messagesRef.current)
      });
      return;
    }

    if (event.kind === "delta") {
      const payload = event.payload as StreamDeltaPayload;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? { ...message, text: payload.accumulated, isStreaming: true }
            : message
        )
      );
      setCompanionState("thinking");
      return;
    }

    if (event.kind === "final") {
      const payload = event.payload as StreamFinalPayload;
      const displayText =
        sanitizeLocalAssistantText(payload.displayText) ||
        sanitizeLocalAssistantText(payload.speechText) ||
        LOCAL_CHAT_FALLBACK_RESPONSE;
      const speechText =
        sanitizeLocalAssistantText(payload.speechText) ||
        sanitizeLocalAssistantText(payload.displayText) ||
        displayText;
      requestContextsRef.current.delete(event.requestId);
      activeLocalRequestIdRef.current = null;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? {
                ...message,
                text: displayText,
                isStreaming: false,
                widget: null,
                followUpQuestions: []
              }
            : message
        )
      );
      setStatus(null);
      if (ttsEnabled) {
        patchLatencyByRequestKey(event.requestId, (current) => ({
          ...current,
          ttsRequestId: event.requestId,
          ttsRequestedAtMs: current.ttsRequestedAtMs ?? Date.now()
        }));
        await speakText(event.requestId, speechText, selectedTtsVoice);
      } else {
        setCompanionState("idle");
      }
      return;
    }

    if (event.kind === "error") {
      const payload = event.payload as StreamErrorPayload;
      requestContextsRef.current.delete(event.requestId);
      activeLocalRequestIdRef.current = null;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? {
                ...message,
                text: payload.message,
                isStreaming: false
              }
            : message
        )
      );
      setError(payload.message);
      setCompanionState("error");
      setStatus(payload.message);
      return;
    }

    const payload = event.payload as StreamTextPayload;
    const nextStatus = payload.text ?? null;
    if (event.kind === "acknowledged") {
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? { ...message, text: nextStatus ?? "", isStreaming: true }
            : message
        )
      );
    }

    setStatus(nextStatus);
    setCompanionState("thinking");
  }

  async function startLocalChatRequest(input: {
    prompt: string;
    source: MessageSource;
    route: PromptRoute;
    existingAssistantMessageId?: string;
    statusText?: string;
  }) {
    const startedAtMs = Date.now();
    await stopSpeaking();
    await cleanupDesktopAvatarRuntime();

    let requestId: string;
    let nextMessages: ChatMessage[];
    if (input.existingAssistantMessageId) {
      requestId = input.existingAssistantMessageId;
      nextMessages = messagesRef.current.map((message) =>
        message.id === requestId
          ? {
              ...message,
              text: "",
              isStreaming: true,
              widget: null,
              followUpQuestions: [],
              requestStatus: null,
              avatarRequestId: null,
              clientRequestId: null
            }
          : message
      );
    } else {
      const userMessage = buildUserMessage(input.prompt, input.source);
      const assistantMessage = buildAssistantPlaceholder(input.source);
      requestId = assistantMessage.id;
      nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    }

    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    requestContextsRef.current.set(requestId, {
      prompt: input.prompt,
      source: input.source,
      route: "localChat"
    });
    activeLocalRequestIdRef.current = requestId;
    activeDesktopAvatarRequestRef.current = null;
    desktopAvatarDispatch({ type: "reset" });
    setLatencyTimeline({
      requestKey: requestId,
      requestKind: "local-chat",
      route: input.route,
      source: input.source,
      status: "starting",
      startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      usedPolling: false,
      ttsProvider: null,
      ttsFallbackUsed: null,
      lastError: null,
      clientRequestId: null,
      avatarRequestId: null,
      ttsRequestId: null
    });

    if (peekMode === "peek") {
      await applyPeekMode("expanded");
    }

    setCompanionState("thinking");
    setStatus(input.statusText ?? t("status.thinkingLocally"));

    try {
      const request: LocalChatRequest = {
        requestId,
        prompt: input.prompt,
        messages: buildLocalHistory(nextMessages)
      };
      await sendLocalChat(request);
    } catch (caughtError) {
      const message = errorMessage(caughtError, t("status.requestCouldNotStart"));
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: "error",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message
      }));
      await handleLocalStreamEvent({
        requestId,
        source: "local",
        kind: "error",
        payload: { message }
      });
    }
  }

  async function submitDesktopAvatarPrompt(
    prompt: string,
    source: MessageSource,
    route: PromptRoute,
    clientRequestId?: string
  ) {
    const requestId = clientRequestId ?? `desktop-avatar-client:${crypto.randomUUID()}`;
    const startedAtMs = Date.now();
    const userMessage = buildUserMessage(prompt, source);
    const assistantMessage = buildAssistantPlaceholder(source, requestId);
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setStatus(t("status.sendingRequest"));
    desktopAvatarDispatch({ type: "createRequested", clientRequestId: requestId });
    lastSubmissionRef.current = { prompt, source, route, clientRequestId: requestId };
    activeLocalRequestIdRef.current = null;
    activeDesktopAvatarRequestRef.current = {
      assistantMessageId: assistantMessage.id,
      avatarRequestId: null,
      clientRequestId: requestId,
      prompt,
      source,
      route
    };
    setLatencyTimeline({
      requestKey: requestId,
      requestKind: "desktop-avatar",
      route,
      source,
      status: "creating",
      startedAtMs,
      startedAt: new Date(startedAtMs).toISOString(),
      usedPolling: false,
      ttsProvider: null,
      ttsFallbackUsed: null,
      lastError: null,
      clientRequestId: requestId,
      avatarRequestId: null,
      ttsRequestId: null
    });

    if (peekMode === "peek") {
      await applyPeekMode("expanded");
    }

    await stopSpeaking();
    await cleanupDesktopAvatarRuntime();

    try {
      const result = await desktopAvatarApiClient.createRequest(
        buildDesktopAvatarRequestInput(prompt, source, requestId)
      );
      activeDesktopAvatarRequestRef.current = {
        ...(activeDesktopAvatarRequestRef.current ?? {
          assistantMessageId: assistantMessage.id,
          clientRequestId: requestId,
          prompt,
          source,
          route
        }),
        avatarRequestId: result.avatarRequestId
      };
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: result.status,
        avatarRequestId: result.avatarRequestId,
        createAcceptedAtMs: current.createAcceptedAtMs ?? Date.now()
      }));
      desktopAvatarDispatch({ type: "createAccepted", result });
      await connectDesktopAvatarStream(result.avatarRequestId, result.streamUrl, result.pollUrl);
    } catch (caughtError) {
      const message = errorMessage(caughtError, t("status.requestCouldNotStart"));
      if (isUnsupportedNoMatchErrorMessage(message)) {
        await startLocalChatRequest({
          prompt,
          source,
          route,
          existingAssistantMessageId:
            activeDesktopAvatarRequestRef.current?.assistantMessageId ??
            assistantMessage.id,
          statusText: t("status.continuingLocally")
        });
        return;
      }
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: "FAILED",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message
      }));
      desktopAvatarDispatch({ type: "requestFailed", message });
    }
  }

  async function submitPrompt(
    rawPrompt: string,
    source: MessageSource,
    retryClientRequestId?: string
  ) {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return;
    }

    const route = routePrompt(prompt);
    lastSubmissionRef.current = { prompt, source, route, clientRequestId: retryClientRequestId };
    setError(null);

    if (route === "localChat") {
      await startLocalChatRequest({ prompt, source, route });
      return;
    }

    await submitDesktopAvatarPrompt(prompt, source, route, retryClientRequestId);
  }

  async function setUiMode(mode: PeekMode, options?: { animate?: boolean }) {
    if (mode === peekMode) {
      return;
    }
    await applyPeekMode(mode, options);
  }

  async function toggleExpanded() {
    const nextMode: PeekMode = peekMode === "expanded" ? "peek" : "expanded";
    await setUiMode(nextMode);
  }

  async function setSizePreset(preset: SizePreset) {
    if (preset === sizePreset) {
      return;
    }

    const presetSizes = getWindowSizesForPreset(preset);
    setSizePresetState(preset);
    storeSizePreset(preset);

    const targetSize = {
      width: presetSizes.expanded.width,
      height: Math.max(windowSize.height, presetSizes.expanded.height)
    };
    if (peekMode === "expanded") {
      await resizeWindow(targetSize.width, targetSize.height);
      setWindowSize(targetSize);
      storeLastExpandedSize(targetSize.width, targetSize.height);
      await setPeekMode(
        "expanded",
        targetSize.width,
        targetSize.height,
        presetSizes.collapsed.width,
        presetSizes.collapsed.height,
        false
      );
      return;
    }

    await setPeekMode(
      "peek",
      targetSize.width,
      targetSize.height,
      presetSizes.collapsed.width,
      presetSizes.collapsed.height,
      false
    );
  }

  async function retryLastPrompt() {
    if (!lastSubmissionRef.current) {
      return;
    }

    const { prompt, source, route, clientRequestId } = lastSubmissionRef.current;
    const retryId = route === "localChat" ? undefined : clientRequestId;
    await submitPrompt(prompt, source, retryId);
  }

  async function startRecording() {
    if (isRecording) {
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm"
          });
          const audioBase64 = await blobToBase64(blob);
          setCompanionState("transcribing");
          setStatus(t("status.transcribing"));
          const transcript = await transcribeAudio({
            audioBase64,
            mimeType: blob.type || "audio/webm"
          });
          setStatus(null);
          if (transcript.trim()) {
            await submitPrompt(transcript, "voice");
          } else {
            setCompanionState("idle");
          }
        } catch (caughtError) {
          const message =
            caughtError instanceof Error
              ? caughtError.message
              : t("status.voiceTranscriptionFailed");
          setError(message);
          setStatus(message);
          setCompanionState("error");
        } finally {
          setIsRecording(false);
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          mediaRecorderRef.current = null;
          chunksRef.current = [];
        }
      };

      recorder.start();
      setError(null);
      setIsRecording(true);
      setCompanionState("listening");
      setStatus(t("status.listening"));
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : t("status.microphoneAccessFailed");
      setError(message);
      setStatus(message);
      setCompanionState("error");
      setIsRecording(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      chunksRef.current = [];
    }
  }

  async function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  async function toggleRecording() {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  const canSend = useMemo(() => draft.trim().length > 0, [draft]);
  const latencyDebug = useMemo(
    () => (latencyTimeline ? toLatencySnapshot(latencyTimeline) : null),
    [latencyTimeline]
  );

  return {
    avatarManifest,
    canSend,
    companionState,
    draft,
    error,
    isExpanded: peekMode === "expanded",
    isModeTransitioning,
    modeTransitionPhase,
    peekMode,
    peekPosition,
    animationEnabled,
    isRecording,
    messages,
    latencyDebug,
    selectedTtsVoice,
    status,
    sizePreset,
    ttsEnabled,
    ttsVoices,
    windowSize,
    activeAnimation: activeDesktopAvatarRequestRef.current
      ? desktopAvatarState.animation
      : null,
    setDraft,
    setSizePreset,
    submitCurrentDraft: () => submitPrompt(draft, "text"),
    submitSuggestion: (value: string) => submitPrompt(value, "text"),
    toggleExpanded,
    openAgent: () => setUiMode("expanded"),
    collapseToPeek: () => setUiMode("peek"),
    setPeekPosition: (position: PeekPosition) => applyPeekPosition(position),
    toggleRecording,
    retryLastPrompt,
    selectTtsVoice: (voice: string | null) => {
      const normalized = voice?.trim() ?? "";
      const nextVoice = normalized.length > 0 ? normalized : null;
      setSelectedTtsVoiceState(nextVoice);
      storeTtsVoice(nextVoice);
    },
    toggleTts: async () => {
      if (ttsEnabled) {
        await stopSpeaking();
      }
      setTtsEnabled((current) => {
        const next = !current;
        storeTtsEnabled(next);
        return next;
      });
    },
    resizeWindow: async (width: number, height: number) => {
      await resizeWindow(width, height);
      setWindowSize({ width, height });
      storeLastExpandedSize(width, height);
    },
    startWindowDrag: () => startWindowDragForMode(peekModeRef.current)
  };
}
