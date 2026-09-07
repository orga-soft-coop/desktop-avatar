import { useHitlDecisions } from "./useHitlDecisions";
import { useCompanionWindow } from "./useCompanionWindow";
import { useSpeechOutput } from "./useSpeechOutput";
import { useVoiceCapture } from "./useVoiceCapture";
import { useOperatorRadar } from "./useOperatorRadar";
import { errorMessage } from "../lib/companion-utils";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  ChatMessage,
  CompanionState,
  CreateDesktopAvatarRequestInput,
  BackendConnectionState,
  DesktopAvatarDatasetPage,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DevToolsLatencySnapshot,
  MessageSource,
  PeekPosition,
  PromptRoute,
  TranscriptionProviderId,
} from "../lib/contracts";
import {
  desktopAvatarApiClient,
  type DesktopAvatarStreamConnection,
} from "../lib/desktop-avatar-api";
import {
  desktopAvatarInitialState,
  reduceDesktopAvatarState,
  type DesktopAvatarOrchestratorState,
  isTerminalDesktopAvatarDocument,
} from "../lib/desktop-avatar-orchestrator";
import { routePrompt } from "../lib/router";
import {
  getLocale,
  setLocale as setI18nLocale,
  supportedLocales,
  t,
  type LocaleId,
} from "../lib/i18n";
import {
  frontendLog,
  getTranscriptionProvider,
  getBootstrapState,
  listTtsVoices,
  onTranscriptionProviderChanged,
  onTtsState,
  stopSpeaking,
  setTranscriptionProvider,
} from "../lib/tauri";
import {
  getRequiredTenantContextId,
  isCurrentTenantContext,
} from "../lib/tenant-session";

const TTS_VOICE_STORAGE_KEY = "desktop-avatar.ttsVoice";
const TTS_ENABLED_STORAGE_KEY = "desktop-avatar.ttsEnabled";
const LEGACY_OPENAI_TTS_DEFAULT_VOICE = "onyx";
const PREFERRED_OPENAI_TTS_DEFAULT_VOICE = "shimmer";

interface SubmissionContext {
  prompt: string;
  source: MessageSource;
  route: PromptRoute;
  clientRequestId?: string;
  clarificationReply?: ClarificationReplyContext;
}

interface ClarificationReplyContext {
  avatarRequestId: string;
  clarificationId: string;
  conversationId: string;
  parentAssistantMessageId: string;
  expiresAt?: string;
}

interface ActiveDesktopAvatarRequest extends SubmissionContext {
  assistantMessageId: string;
  avatarRequestId: string | null;
  clientRequestId: string;
  conversationId: string | null;
}

interface LatencyTimeline {
  requestKey: string;
  requestKind: "desktop-avatar";
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

function buildAssistantPlaceholder(
  source: MessageSource,
  clientRequestId?: string,
): ChatMessage {
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
    followUpQuestions: [],
  };
}

function buildUserMessage(text: string, source: MessageSource): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text,
    createdAt: new Date().toISOString(),
    source,
  };
}

function buildDesktopAvatarRequestInput(
  prompt: string,
  source: MessageSource,
  clientRequestId: string,
  locale: LocaleId,
): CreateDesktopAvatarRequestInput {
  return {
    clientRequestId,
    mode: "SIMULATION",
    modality: source === "voice" ? "voice" : "chat",
    locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utterance: prompt,
    responseModes: ["talk", "widget"],
    autoStart: true,
  };
}

function authoritativeClarificationState(
  message: string,
): "answered" | "expired" | null {
  const normalized = message.toLowerCase();
  if (
    /\b410\b/.test(normalized) ||
    normalized.includes("expired") ||
    normalized.includes("abgelaufen")
  ) {
    return "expired";
  }
  if (
    (/\b409\b/.test(normalized) || normalized.includes("conflict")) &&
    (normalized.includes("already answered") ||
      normalized.includes("already has a reply") ||
      normalized.includes("already resolved") ||
      normalized.includes("not awaiting") ||
      normalized.includes("no longer awaiting") ||
      normalized.includes("bereits beantwortet") ||
      normalized.includes("bereits abgeschlossen"))
  ) {
    return "answered";
  }
  return null;
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

function resolvePreferredTtsVoice(
  currentVoice: string | null,
  availableVoices: string[],
): string | null {
  const normalizedCurrent = currentVoice?.trim() ?? "";
  const hasPreferredVoice = availableVoices.includes(
    PREFERRED_OPENAI_TTS_DEFAULT_VOICE,
  );

  if (normalizedCurrent.length === 0) {
    return hasPreferredVoice ? PREFERRED_OPENAI_TTS_DEFAULT_VOICE : null;
  }

  if (!availableVoices.includes(normalizedCurrent)) {
    return hasPreferredVoice ? PREFERRED_OPENAI_TTS_DEFAULT_VOICE : null;
  }

  if (
    normalizedCurrent === LEGACY_OPENAI_TTS_DEFAULT_VOICE &&
    hasPreferredVoice
  ) {
    return PREFERRED_OPENAI_TTS_DEFAULT_VOICE;
  }

  return normalizedCurrent;
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
    createAcceptedMs: elapsed(
      timeline.startedAtMs,
      timeline.createAcceptedAtMs,
    ),
    streamConnectedMs: elapsed(
      timeline.startedAtMs,
      timeline.streamConnectedAtMs,
    ),
    firstEventMs: elapsed(timeline.startedAtMs, timeline.firstEventAtMs),
    firstResponseMs: elapsed(timeline.startedAtMs, timeline.firstResponseAtMs),
    talkMs: elapsed(timeline.startedAtMs, timeline.talkAtMs),
    widgetMs: elapsed(timeline.startedAtMs, timeline.widgetAtMs),
    pollFallbackMs: elapsed(timeline.startedAtMs, timeline.pollingStartedAtMs),
    completedMs: elapsed(timeline.startedAtMs, timeline.completedAtMs),
    failedMs: elapsed(timeline.startedAtMs, timeline.failedAtMs),
    ttsRequestedMs: elapsed(timeline.startedAtMs, timeline.ttsRequestedAtMs),
    ttsStartedMs: elapsed(timeline.startedAtMs, timeline.ttsStartedAtMs),
    ttsSpeakDurationMs: duration(
      timeline.ttsStartedAtMs,
      timeline.ttsEndedAtMs,
    ),
    talkToTtsStartMs: duration(timeline.talkAtMs, timeline.ttsStartedAtMs),
    ttsProvider: timeline.ttsProvider,
    ttsFallbackUsed: timeline.ttsFallbackUsed,
    lastError: timeline.lastError,
    clientRequestId: timeline.clientRequestId,
    avatarRequestId: timeline.avatarRequestId,
    ttsRequestId: timeline.ttsRequestId,
  };
}

export function useDesktopCompanion() {
  const [tenantContextId] = useState(() => getRequiredTenantContextId());
  const radar = useOperatorRadar(tenantContextId);
  const windowController = useCompanionWindow();
  const { peekMode, peekPosition, isModeTransitioning, modeTransitionPhase, animationEnabled, sizePreset, windowSize, applyPeekMode, applyPeekPosition, setUiMode, toggleExpanded, setSizePreset } = windowController;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(
    () => readStoredTtsEnabled() ?? true,
  );
  const [locale, setLocaleState] = useState<LocaleId>(() => getLocale());
  const [transcriptionProvider, setTranscriptionProviderState] =
    useState<TranscriptionProviderId>("openai-realtime");
  const [transcriptionProviders, setTranscriptionProvidersState] = useState<
    TranscriptionProviderId[]
  >(["openai-realtime", "openai-file-fallback"]);
  const [ttsVoices, setTtsVoices] = useState<string[]>([]);
  const [selectedTtsVoice, setSelectedTtsVoiceState] = useState<string | null>(
    () => readStoredTtsVoice(),
  );
  const [desktopAvatarState, desktopAvatarDispatch] = useReducer(
    reduceDesktopAvatarState,
    desktopAvatarInitialState,
  );
  const [latencyTimeline, setLatencyTimeline] =
    useState<LatencyTimeline | null>(null);
  const [backendConnectionState, setBackendConnectionState] =
    useState<BackendConnectionState>("connecting");
  const [pendingClarification, setPendingClarification] =
    useState<ClarificationReplyContext | null>(null);

  const { isRecording, toggleRecording } = useVoiceCapture({
    tenantContextId, transcriptionProvider, setStatus, setError, setCompanionState,
    onTranscript: (text, contextId) => submitPrompt(text, "voice", undefined, contextId)
  });

  const requestContextsRef = useRef(new Map<string, SubmissionContext>());
  const messagesRef = useRef<ChatMessage[]>([]);
  const lastSubmissionRef = useRef<SubmissionContext | null>(null);
  const conversationEpochRef = useRef(0);
  const activeDesktopAvatarRequestRef =
    useRef<ActiveDesktopAvatarRequest | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const pendingClarificationRef = useRef<ClarificationReplyContext | null>(
    null,
  );
  const legacyClarificationBlockedRef = useRef(false);
  const clarificationReplyInFlightRef = useRef(false);
  const desktopAvatarStateRef = useRef<DesktopAvatarOrchestratorState>(
    desktopAvatarInitialState,
  );
  const desktopAvatarConnectionRef =
    useRef<DesktopAvatarStreamConnection | null>(null);
  const desktopAvatarConnectionGenerationRef = useRef(0);
  const desktopAvatarPollTimeoutRef = useRef<number | null>(null);
  const desktopAvatarPollAttemptRef = useRef(0);
  const desktopAvatarPollErrorCountRef = useRef(0);
  const lastSpokenDesktopAvatarKeyRef = useRef<string | null>(null);
  const stoppedRequestIdsRef = useRef(new Set<string>());
  const stoppingOutputRef = useRef(false);
  const [isStoppingOutput, setIsStoppingOutput] = useState(false);
  const { hasSpeechOutput, isTtsSpeakingRef, requestSpeech, stopSpeechOutput, acceptSpeechState } = useSpeechOutput(tenantContextId);
  const ttsEnabledRef = useRef(ttsEnabled);
  const selectedTtsVoiceRef = useRef(selectedTtsVoice);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    selectedTtsVoiceRef.current = selectedTtsVoice;
  }, [selectedTtsVoice]);

  const { hitlWidgets, approveHitl, rejectHitl, requestMoreInfoForHitl, openHitl } = useHitlDecisions({
    tenantContextId, setBackendConnectionState, setStatus, setCompanionState,
    ttsEnabledRef, selectedTtsVoiceRef, requestSpeech
  });

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const updatePendingClarification = useCallback(
    (next: ClarificationReplyContext | null) => {
      pendingClarificationRef.current = next;
      setPendingClarification(next);
    },
    [],
  );

  useEffect(() => {
    desktopAvatarStateRef.current = desktopAvatarState;
  }, [desktopAvatarState]);

  const patchLatencyByRequestKey = useCallback(
    (
      requestKey: string,
      updater: (current: LatencyTimeline) => LatencyTimeline,
    ) => {
      setLatencyTimeline((current) => {
        if (!current || current.requestKey !== requestKey) {
          return current;
        }
        return updater(current);
      });
    },
    [],
  );

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
          avatarRequestId:
            current.avatarRequestId ?? activeRequest.avatarRequestId ?? null,
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
    [patchLatencyByRequestKey],
  );

  const markDesktopPollingStarted = useCallback(
    (requestKey: string) => {
      const now = Date.now();
      patchLatencyByRequestKey(requestKey, (current) => ({
        ...current,
        usedPolling: true,
        pollingStartedAtMs: current.pollingStartedAtMs ?? now,
      }));
    },
    [patchLatencyByRequestKey],
  );

  const markDesktopPollingSnapshot = useCallback(
    (requestKey: string, document: DesktopAvatarRequestDocument) => {
      const now = Date.now();
      patchLatencyByRequestKey(requestKey, (current) => {
        const next: LatencyTimeline = {
          ...current,
          firstEventAtMs: current.firstEventAtMs ?? now,
          status: document.status,
          avatarRequestId:
            current.avatarRequestId ?? document.avatarRequestId ?? null,
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
        } else if (isTerminalDesktopAvatarDocument(document)) {
          next.completedAtMs = current.completedAtMs ?? now;
        }

        return next;
      });
    },
    [patchLatencyByRequestKey],
  );

  const syncDesktopAvatarMessage = useCallback(
    (state: DesktopAvatarOrchestratorState) => {
      const activeRequest = activeDesktopAvatarRequestRef.current;
      if (!activeRequest) {
        return;
      }

      setMessages((current) =>
        current.map((message) => {
          if (message.id !== activeRequest.assistantMessageId) {
            return message;
          }

          const clarificationReplyCapable =
            state.widget?.type === "clarification" &&
            Boolean(state.widget.clarificationId?.trim()) &&
            Boolean(
              state.widget.conversationId?.trim() ||
                state.conversationId?.trim() ||
                activeRequest.conversationId?.trim(),
            );
          const clarificationState =
            state.widget?.type === "clarification"
              ? clarificationReplyCapable
                ? message.clarificationState === "unavailable"
                  ? "pending"
                  : message.clarificationState ?? "pending"
                : "unavailable"
              : message.clarificationState;

          return {
            ...message,
            text: state.talkText || state.error || message.text,
            widget: state.widget,
            followUpQuestions: state.followUpQuestions,
            isStreaming: !state.isDone,
            requestStatus: state.status,
            avatarRequestId: activeRequest.avatarRequestId,
            clientRequestId: activeRequest.clientRequestId,
            clarificationState,
          };
        }),
      );
    },
    [],
  );

  const clearDesktopAvatarPolling = useCallback(() => {
    if (desktopAvatarPollTimeoutRef.current !== null) {
      window.clearTimeout(desktopAvatarPollTimeoutRef.current);
      desktopAvatarPollTimeoutRef.current = null;
    }
  }, []);

  const closeDesktopAvatarConnection = useCallback(async () => {
    desktopAvatarConnectionGenerationRef.current += 1;
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
        if (
          !activeRequest ||
          activeRequest.avatarRequestId !== avatarRequestId
        ) {
          return;
        }

        try {
          const document = await desktopAvatarApiClient.getRequest({
            avatarRequestId,
            pollUrl,
          }, tenantContextId);
          const latestRequest = activeDesktopAvatarRequestRef.current;
          if (
            !latestRequest ||
            latestRequest.avatarRequestId !== avatarRequestId ||
            latestRequest.clientRequestId !== activeRequest.clientRequestId
          ) {
            return;
          }
          desktopAvatarPollErrorCountRef.current = 0;
          markDesktopPollingSnapshot(latestRequest.clientRequestId, document);
          desktopAvatarDispatch({ type: "pollingSnapshot", document });
          if (isTerminalDesktopAvatarDocument(document)) {
            clearDesktopAvatarPolling();
            return;
          }
        } catch (caughtError) {
          if (activeDesktopAvatarRequestRef.current !== activeRequest) return;
          desktopAvatarPollErrorCountRef.current += 1;
          const message =
            caughtError instanceof Error
              ? caughtError.message
              : t("status.pollingFallbackFailed");
          if (desktopAvatarPollErrorCountRef.current >= 3) {
            patchLatencyByRequestKey(
              activeRequest.clientRequestId,
              (current) => ({
                ...current,
                status: "FAILED",
                failedAtMs: current.failedAtMs ?? Date.now(),
                lastError: message,
              }),
            );
            desktopAvatarDispatch({ type: "requestFailed", message });
            clearDesktopAvatarPolling();
            return;
          }
          desktopAvatarDispatch({
            type: "streamDisconnected",
            reason: message,
          });
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
      patchLatencyByRequestKey,
    ],
  );

  const cleanupDesktopAvatarRuntime = useCallback(async () => {
    clearDesktopAvatarPolling();
    await closeDesktopAvatarConnection();
  }, [clearDesktopAvatarPolling, closeDesktopAvatarConnection]);

  const connectDesktopAvatarStream = useCallback(
    async (avatarRequestId: string, streamUrl: string, pollUrl: string) => {
      await closeDesktopAvatarConnection();
      clearDesktopAvatarPolling();
      const generation = desktopAvatarConnectionGenerationRef.current;
      if (activeDesktopAvatarRequestRef.current?.avatarRequestId !== avatarRequestId) return;
      const connection = await desktopAvatarApiClient.connectStream({
          avatarRequestId,
          streamUrl,
          expectedContextId: tenantContextId,
          onEvent: (event) => {
            const activeRequest = activeDesktopAvatarRequestRef.current;
            if (
              !activeRequest ||
              activeRequest.avatarRequestId !== avatarRequestId
            ) {
              return;
            }
            markDesktopStreamEvent(event);
            desktopAvatarDispatch({ type: "streamEvent", event });
          },
          onDisconnect: (event) => {
            const activeRequest = activeDesktopAvatarRequestRef.current;
            if (
              !activeRequest ||
              activeRequest.avatarRequestId !== avatarRequestId
            ) {
              return;
            }
            if (event.phase === "aborted") {
              return;
            }
            desktopAvatarDispatch({
              type: "streamDisconnected",
              reason: event.reason,
            });
            startDesktopAvatarPolling(avatarRequestId, pollUrl);
          },
        });
      if (generation !== desktopAvatarConnectionGenerationRef.current) {
        await connection.close();
        return;
      }
      desktopAvatarConnectionRef.current = connection;
      const activeRequest = activeDesktopAvatarRequestRef.current;
      if (activeRequest && activeRequest.avatarRequestId === avatarRequestId) {
        patchLatencyByRequestKey(activeRequest.clientRequestId, (current) => ({
          ...current,
          avatarRequestId,
          streamConnectedAtMs: current.streamConnectedAtMs ?? Date.now(),
        }));
      }
    },
    [
      clearDesktopAvatarPolling,
      closeDesktopAvatarConnection,
      markDesktopStreamEvent,
      patchLatencyByRequestKey,
      startDesktopAvatarPolling,
    ],
  );

  useEffect(() => {
    let active = true;
    let unlistenTts: (() => void) | undefined;
    let unlistenTranscriptionProvider: (() => void) | undefined;

    void (async () => {
      const bootstrap = await getBootstrapState();
      if (!active) return;
      setTtsEnabled(() => {
        const stored = readStoredTtsEnabled();
        const next = bootstrap.ttsEnabled ? (stored ?? true) : false;
        storeTtsEnabled(next);
        return next;
      });
      setTranscriptionProviderState(bootstrap.transcriptionProvider);
      setTranscriptionProvidersState(bootstrap.transcriptionProviders);

      void getTranscriptionProvider()
        .then((provider) => {
          if (active) setTranscriptionProviderState(provider);
        })
        .catch(() => undefined);
      await windowController.initializeWindow(() => active);
      if (!active) return;
      setBootstrapReady(true);

      try {
        const voices = await listTtsVoices();
        const normalized = [
          ...new Set(voices.map((voice) => voice.trim()).filter(Boolean)),
        ];
        if (!active) return;
        setTtsVoices(normalized);
        setSelectedTtsVoiceState((current) => {
          const nextVoice = resolvePreferredTtsVoice(current, normalized);
          storeTtsVoice(nextVoice);
          return nextVoice;
        });
      } catch {
        if (active) setTtsVoices([]);
      }
    })();

    void onTtsState((event) => {
      if (!active || !acceptSpeechState(event)) return;
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
            ttsFallbackUsed: nextFallback ?? current.ttsFallbackUsed,
          };
        }
        return {
          ...current,
          ttsEndedAtMs:
            typeof current.ttsStartedAtMs === "number" && !current.ttsEndedAtMs
              ? now
              : current.ttsEndedAtMs,
          ttsProvider: nextProvider ?? current.ttsProvider,
          ttsFallbackUsed: nextFallback ?? current.ttsFallbackUsed,
        };
      });
      isTtsSpeakingRef.current = event.speaking;
      if (event.speaking) {
        setCompanionState("speaking");
        return;
      }

      if (activeDesktopAvatarRequestRef.current) {
        setCompanionState(desktopAvatarStateRef.current.companionState);
      } else {
        setCompanionState("idle");
        setStatus(null);
      }
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTts = unlisten;
    });

    void onTranscriptionProviderChanged((event) => {
      if (!active) return;
      setTranscriptionProviderState(event.provider);
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTranscriptionProvider = unlisten;
    });

    return () => {
      active = false;
      unlistenTts?.();
      unlistenTranscriptionProvider?.();
      void cleanupDesktopAvatarRuntime();
    };
  }, [
    cleanupDesktopAvatarRuntime,
  ]);

  useEffect(() => {
    const activeRequest = activeDesktopAvatarRequestRef.current;
    if (!activeRequest) {
      return;
    }

    if (desktopAvatarState.conversationId) {
      activeRequest.conversationId = desktopAvatarState.conversationId;
      activeConversationIdRef.current = desktopAvatarState.conversationId;
    }

    syncDesktopAvatarMessage(desktopAvatarState);
    setStatus(
      desktopAvatarState.error ??
        (desktopAvatarState.phase === "awaiting-clarification"
          ? t("status.awaitingClarification")
          : desktopAvatarState.statusMessage),
    );
    setError(desktopAvatarState.error);
    if (!isTtsSpeakingRef.current) {
      setCompanionState(desktopAvatarState.companionState);
    }
  }, [desktopAvatarState, syncDesktopAvatarMessage]);

  useEffect(() => {
    const activeRequest = activeDesktopAvatarRequestRef.current;
    const widget = desktopAvatarState.widget;
    if (!activeRequest || widget?.type !== "clarification") {
      return;
    }

    const clarificationId = widget.clarificationId?.trim();
    const conversationId =
      widget.conversationId?.trim() ||
      desktopAvatarState.conversationId?.trim() ||
      activeRequest.conversationId?.trim();
    if (!activeRequest.avatarRequestId || !clarificationId || !conversationId) {
      legacyClarificationBlockedRef.current = true;
      updatePendingClarification(null);
      const nextMessages = messagesRef.current.map((message) =>
        message.id === activeRequest.assistantMessageId
          ? { ...message, clarificationState: "unavailable" as const }
          : message,
      );
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      return;
    }

    legacyClarificationBlockedRef.current = false;
    activeConversationIdRef.current = conversationId;
    const expiresAt = widget.expiresAt?.trim() || undefined;
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      updatePendingClarification(null);
      const nextMessages = messagesRef.current.map((message) =>
        message.id === activeRequest.assistantMessageId
          ? { ...message, clarificationState: "expired" as const }
          : message,
      );
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setStatus(t("status.clarificationExpired"));
      setCompanionState("idle");
      return;
    }

    const next: ClarificationReplyContext = {
      avatarRequestId: activeRequest.avatarRequestId,
      clarificationId,
      conversationId,
      parentAssistantMessageId: activeRequest.assistantMessageId,
      expiresAt,
    };
    updatePendingClarification(next);
    setMessages((current) =>
      current.map((message) =>
        message.id === activeRequest.assistantMessageId &&
        message.clarificationState !== "answered"
          ? { ...message, clarificationState: "pending" }
          : message,
      ),
    );
  }, [desktopAvatarState, updatePendingClarification]);

  useEffect(() => {
    if (!pendingClarification?.expiresAt) {
      return;
    }
    const expiresAtMs = Date.parse(pendingClarification.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }

    const expire = () => {
      const current = pendingClarificationRef.current;
      if (
        current?.clarificationId !== pendingClarification.clarificationId ||
        current.avatarRequestId !== pendingClarification.avatarRequestId
      ) {
        return;
      }
      updatePendingClarification(null);
      const nextMessages = messagesRef.current.map((message) =>
        message.id === pendingClarification.parentAssistantMessageId
          ? { ...message, clarificationState: "expired" as const }
          : message,
      );
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setStatus(t("status.clarificationExpired"));
      setCompanionState("idle");
    };

    const remainingMs = expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    if (remainingMs > 2_147_000_000) {
      return;
    }

    const timeoutId = window.setTimeout(expire, remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [pendingClarification, updatePendingClarification]);

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
        ttsRequestedAtMs: current.ttsRequestedAtMs ?? requestedAtMs,
      }));
      requestSpeech(activeRequest.avatarRequestId, desktopAvatarState.talkText, selectedTtsVoice);
    }
  }, [
    desktopAvatarState.talkText,
    patchLatencyByRequestKey,
    selectedTtsVoice,
    ttsEnabled,
  ]);

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
    ttsEnabled,
  ]);

  async function submitDesktopAvatarPrompt(
    prompt: string,
    source: MessageSource,
    route: PromptRoute,
    clientRequestId?: string,
    capturedContextId = tenantContextId,
  ) {
    if (!isCurrentTenantContext(capturedContextId)) {
      throw new Error("DESKTOP_SESSION_CHANGED");
    }
    updatePendingClarification(null);
    legacyClarificationBlockedRef.current = false;
    activeConversationIdRef.current = null;
    const requestEpoch = ++conversationEpochRef.current;
    const requestId =
      clientRequestId ?? `desktop-avatar-client:${crypto.randomUUID()}`;
    const startedAtMs = Date.now();
    const userMessage = buildUserMessage(prompt, source);
    const assistantMessage = buildAssistantPlaceholder(source, requestId);
    const nextMessages = [
      ...messagesRef.current,
      userMessage,
      assistantMessage,
    ];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setStatus(t("status.sendingRequest"));
    desktopAvatarDispatch({
      type: "createRequested",
      clientRequestId: requestId,
    });
    lastSubmissionRef.current = {
      prompt,
      source,
      route,
      clientRequestId: requestId,
    };
    activeDesktopAvatarRequestRef.current = {
      assistantMessageId: assistantMessage.id,
      avatarRequestId: null,
      clientRequestId: requestId,
      conversationId: null,
      prompt,
      source,
      route,
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
      ttsRequestId: null,
    });

    if (peekMode === "peek") {
      await applyPeekMode("expanded");
      if (!isCurrentTenantContext(capturedContextId) || requestEpoch !== conversationEpochRef.current) return;
    }

    await stopSpeaking(capturedContextId);
    if (!isCurrentTenantContext(capturedContextId) || requestEpoch !== conversationEpochRef.current) return;
    await cleanupDesktopAvatarRuntime();
    if (!isCurrentTenantContext(capturedContextId) || requestEpoch !== conversationEpochRef.current) return;

    try {
      const result = await desktopAvatarApiClient.createRequest(
        buildDesktopAvatarRequestInput(prompt, source, requestId, locale),
        capturedContextId,
      );
      if (
        requestEpoch !== conversationEpochRef.current ||
        !isCurrentTenantContext(capturedContextId)
      ) {
        if (stoppedRequestIdsRef.current.delete(requestId) && result.conversationId && isCurrentTenantContext(capturedContextId)) {
          await cancelStoppedConversation(result.conversationId, requestEpoch + 1);
        }
        return;
      }
      activeDesktopAvatarRequestRef.current = {
        ...(activeDesktopAvatarRequestRef.current ?? {
          assistantMessageId: assistantMessage.id,
          clientRequestId: requestId,
          conversationId: null,
          prompt,
          source,
          route,
        }),
        avatarRequestId: result.avatarRequestId,
        conversationId: result.conversationId ?? null,
      };
      activeConversationIdRef.current = result.conversationId ?? null;
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: result.status,
        avatarRequestId: result.avatarRequestId,
        createAcceptedAtMs: current.createAcceptedAtMs ?? Date.now(),
      }));
      desktopAvatarDispatch({ type: "createAccepted", result });
      await connectDesktopAvatarStream(
        result.avatarRequestId,
        result.streamUrl,
        result.pollUrl,
      );
    } catch (caughtError) {
      if (requestEpoch !== conversationEpochRef.current) {
        return;
      }
      const message = errorMessage(
        caughtError,
        t("status.requestCouldNotStart"),
      );
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: "FAILED",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message,
      }));
      desktopAvatarDispatch({ type: "requestFailed", message });
    }
  }

  async function submitClarificationReply(
    answer: string,
    source: MessageSource,
    clarification: ClarificationReplyContext,
    clientRequestId?: string,
  ) {
    const capturedContextId = tenantContextId;
    if (!isCurrentTenantContext(capturedContextId)) {
      throw new Error("DESKTOP_SESSION_CHANGED");
    }
    if (clarificationReplyInFlightRef.current) {
      return;
    }

    const expiresAtMs = clarification.expiresAt
      ? Date.parse(clarification.expiresAt)
      : Number.NaN;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      updatePendingClarification(null);
      const nextMessages = messagesRef.current.map((message) =>
        message.id === clarification.parentAssistantMessageId
          ? { ...message, clarificationState: "expired" as const }
          : message,
      );
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setError(null);
      setStatus(t("status.clarificationExpired"));
      setCompanionState("idle");
      return;
    }

    clarificationReplyInFlightRef.current = true;
    legacyClarificationBlockedRef.current = false;
    const requestEpoch = ++conversationEpochRef.current;
    const requestId =
      clientRequestId ?? `desktop-avatar-client:${crypto.randomUUID()}`;
    const route = lastSubmissionRef.current?.route ?? "backendBusiness";
    const startedAtMs = Date.now();
    const userMessage = buildUserMessage(answer, source);
    const assistantMessage = buildAssistantPlaceholder(source, requestId);
    const parentMessages = messagesRef.current.map((message) =>
      message.id === clarification.parentAssistantMessageId
        ? { ...message, clarificationState: "submitting" as const }
        : message,
    );
    const nextMessages = [...parentMessages, userMessage, assistantMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setStatus(t("status.sendingClarification"));
    desktopAvatarDispatch({
      type: "createRequested",
      clientRequestId: requestId,
    });
    lastSubmissionRef.current = {
      prompt: answer,
      source,
      route,
      clientRequestId: requestId,
      clarificationReply: clarification,
    };
    activeDesktopAvatarRequestRef.current = {
      assistantMessageId: assistantMessage.id,
      avatarRequestId: null,
      clientRequestId: requestId,
      conversationId: clarification.conversationId,
      prompt: answer,
      source,
      route,
      clarificationReply: clarification,
    };
    activeConversationIdRef.current = clarification.conversationId;
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
      ttsRequestId: null,
    });

    try {
      if (peekMode === "peek") {
        await applyPeekMode("expanded");
      }

      await stopSpeaking(capturedContextId);
      if (!isCurrentTenantContext(capturedContextId) || requestEpoch !== conversationEpochRef.current) return;
      await cleanupDesktopAvatarRuntime();
      if (!isCurrentTenantContext(capturedContextId) || requestEpoch !== conversationEpochRef.current) return;

      const result = await desktopAvatarApiClient.replyClarification(
        {
          avatarRequestId: clarification.avatarRequestId,
          clarificationId: clarification.clarificationId,
          request: {
            clientRequestId: requestId,
            answer,
          },
        },
        capturedContextId,
      );
      if (
        requestEpoch !== conversationEpochRef.current ||
        !isCurrentTenantContext(capturedContextId)
      ) {
        if (stoppedRequestIdsRef.current.delete(requestId) && result.conversationId && isCurrentTenantContext(capturedContextId)) {
          await cancelStoppedConversation(result.conversationId, requestEpoch + 1);
        }
        return;
      }

      const conversationId =
        result.conversationId ?? clarification.conversationId;
      activeConversationIdRef.current = conversationId;
      activeDesktopAvatarRequestRef.current = {
        ...(activeDesktopAvatarRequestRef.current ?? {
          assistantMessageId: assistantMessage.id,
          clientRequestId: requestId,
          conversationId,
          prompt: answer,
          source,
          route,
          clarificationReply: clarification,
        }),
        avatarRequestId: result.avatarRequestId,
        conversationId,
      };
      const answeredMessages = messagesRef.current.map((message) =>
        message.id === clarification.parentAssistantMessageId
          ? { ...message, clarificationState: "answered" as const }
          : message,
      );
      messagesRef.current = answeredMessages;
      setMessages(answeredMessages);
      updatePendingClarification(null);
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: result.status,
        avatarRequestId: result.avatarRequestId,
        createAcceptedAtMs: current.createAcceptedAtMs ?? Date.now(),
      }));
      desktopAvatarDispatch({
        type: "createAccepted",
        result: { ...result, conversationId },
      });
      await connectDesktopAvatarStream(
        result.avatarRequestId,
        result.streamUrl,
        result.pollUrl,
      );
    } catch (caughtError) {
      if (requestEpoch !== conversationEpochRef.current) {
        return;
      }
      const message = errorMessage(
        caughtError,
        t("status.requestCouldNotStart"),
      );
      const serverState = authoritativeClarificationState(message);
      const clarificationExpiredLocally =
        Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
      const finalClarificationState =
        serverState ?? (clarificationExpiredLocally ? "expired" : null);
      const restoredClarificationState: NonNullable<
        ChatMessage["clarificationState"]
      > = finalClarificationState ?? "pending";
      const restoredMessages = messagesRef.current.map((chatMessage) =>
        chatMessage.id === clarification.parentAssistantMessageId
          ? {
              ...chatMessage,
              clarificationState: restoredClarificationState,
            }
          : chatMessage,
      );
      messagesRef.current = restoredMessages;
      setMessages(restoredMessages);
      updatePendingClarification(
        finalClarificationState ? null : clarification,
      );
      if (finalClarificationState) {
        lastSubmissionRef.current = null;
      }
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: "FAILED",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message,
      }));
      desktopAvatarDispatch({ type: "requestFailed", message });
    } finally {
      if (requestEpoch === conversationEpochRef.current) clarificationReplyInFlightRef.current = false;
    }
  }

  async function submitPrompt(
    rawPrompt: string,
    source: MessageSource,
    retryClientRequestId?: string,
    capturedContextId = tenantContextId,
  ) {
    if (!isCurrentTenantContext(capturedContextId)) {
      return;
    }
    if (stoppingOutputRef.current || (activeDesktopAvatarRequestRef.current && !desktopAvatarStateRef.current.isDone)) return;
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return;
    }

    const clarification = pendingClarificationRef.current;
    if (clarification) {
      await submitClarificationReply(
        prompt,
        source,
        clarification,
        retryClientRequestId,
      );
      return;
    }
    if (legacyClarificationBlockedRef.current) {
      setError(null);
      setStatus(t("status.clarificationUnavailable"));
      setCompanionState("idle");
      return;
    }

    const route = routePrompt(prompt);
    if (source === "voice") {
      void frontendLog(
        "info",
        `voice transcript route=${route} prompt=${prompt}`,
      );
    }
    lastSubmissionRef.current = {
      prompt,
      source,
      route,
      clientRequestId: retryClientRequestId,
    };
    setError(null);

    await submitDesktopAvatarPrompt(
      prompt,
      source,
      route,
      retryClientRequestId,
      capturedContextId,
    );
  }

  async function retryLastPrompt() {
    if (!lastSubmissionRef.current) {
      return;
    }

    const { prompt, source, clientRequestId, clarificationReply } =
      lastSubmissionRef.current;
    if (clarificationReply) {
      await submitClarificationReply(
        prompt,
        source,
        clarificationReply,
        clientRequestId,
      );
      return;
    }
    await submitPrompt(prompt, source, clientRequestId);
  }

  async function cancelStoppedConversation(conversationId: string, epoch: number) {
    try {
      await desktopAvatarApiClient.cancelConversation(conversationId, tenantContextId);
    } catch (error) {
      void frontendLog("warn", `conversation cancellation failed: ${errorMessage(error, "CANCEL_FAILED")}`);
      if (isCurrentTenantContext(tenantContextId) && epoch === conversationEpochRef.current) {
        setError(t("chat.stopNotConfirmed"));
      }
    }
  }

  async function stopOutput() {
    if (stoppingOutputRef.current) return;
    stoppingOutputRef.current = true;
    setIsStoppingOutput(true);
    setError(null);
    const request = activeDesktopAvatarRequestRef.current;
    const stopRequest = request && !desktopAvatarStateRef.current.isDone;
    let cancel: Promise<void> = Promise.resolve();
    if (stopRequest) {
      stoppedRequestIdsRef.current.add(request.clientRequestId);
      const epoch = ++conversationEpochRef.current;
      const conversationId = activeConversationIdRef.current;
      activeDesktopAvatarRequestRef.current = null;
      activeConversationIdRef.current = null;
      lastSubmissionRef.current = null;
      clarificationReplyInFlightRef.current = false;
      updatePendingClarification(null);
      const nextMessages = messagesRef.current.map((message) => ({
        ...message,
        ...(message.id === request.assistantMessageId ? { isStreaming: false, outputStopped: true } : {}),
        ...((message.clarificationState === "submitting" || (message.id === request.assistantMessageId && message.clarificationState === "pending")) ? { clarificationState: "unavailable" as const } : {})
      }));
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      desktopAvatarDispatch({ type: "reset" });
      if (conversationId) cancel = cancelStoppedConversation(conversationId, epoch);
    }
    setStatus(t("chat.outputStopped"));
    setCompanionState("idle");
    const results = await Promise.allSettled([
      stopSpeechOutput(),
      stopRequest ? cleanupDesktopAvatarRuntime() : Promise.resolve(),
      cancel
    ]);
    if (!isCurrentTenantContext(tenantContextId)) return;
    if (results.some((result) => result.status === "rejected")) setError(t("chat.stopNotConfirmed"));
    stoppingOutputRef.current = false;
    setIsStoppingOutput(false);
  }

  async function clearConversation() {
    const conversationId = activeConversationIdRef.current;
    conversationEpochRef.current += 1;
    messagesRef.current = [];
    requestContextsRef.current.clear();
    lastSubmissionRef.current = null;
    activeDesktopAvatarRequestRef.current = null;
    activeConversationIdRef.current = null;
    clarificationReplyInFlightRef.current = false;
    legacyClarificationBlockedRef.current = false;
    updatePendingClarification(null);
    lastSpokenDesktopAvatarKeyRef.current = null;
    setMessages([]);
    setDraft("");
    setError(null);
    setStatus(null);
    setLatencyTimeline(null);
    setCompanionState("idle");
    desktopAvatarDispatch({ type: "reset" });
    await stopSpeechOutput();
    await cleanupDesktopAvatarRuntime();
    if (conversationId) {
      await desktopAvatarApiClient
        .cancelConversation(conversationId, tenantContextId)
        .catch((caughtError) => {
          void frontendLog(
            "warn",
            `desktop-avatar conversation cancel failed: ${errorMessage(
              caughtError,
              "unknown error",
            )}`,
          );
        });
    }
  }

  const loadDatasetPage = useCallback(
    (input: {
      avatarRequestId: string;
      resultId: string;
      cursor?: string;
    }): Promise<DesktopAvatarDatasetPage> =>
      desktopAvatarApiClient.getDatasetPage(input, tenantContextId),
    [tenantContextId],
  );

  const canSend = useMemo(() => draft.trim().length > 0, [draft]);
  const latencyDebug = useMemo(
    () => (latencyTimeline ? toLatencySnapshot(latencyTimeline) : null),
    [latencyTimeline],
  );

  return {
    canStopOutput: hasSpeechOutput || Boolean(activeDesktopAvatarRequestRef.current && !desktopAvatarState.isDone),
    isStoppingOutput,
    stopOutput,
    canSend,
    companionState,
    draft,
    error,
    bootstrapReady,
    isExpanded: peekMode === "expanded",
    isModeTransitioning,
    modeTransitionPhase,
    peekMode,
    peekPosition,
    animationEnabled,
    backendConnectionState,
    isRecording,
    messages,
    pendingClarification,
    hitlWidgets,
    operatorRadarWidget: radar.operatorRadarWidget,
    operatorRadarSignalCount: radar.operatorRadarSignalCount,
    locale,
    supportedLocales,
    latencyDebug,
    selectedTtsVoice,
    status,
    sizePreset,
    ttsEnabled,
    ttsVoices,
    transcriptionProvider,
    transcriptionProviders,
    windowSize,
    activeAnimation: isRecording
      ? "attention" as const
      : hasSpeechOutput
        ? "talking" as const
        : activeDesktopAvatarRequestRef.current ? desktopAvatarState.animation : null,
    setDraft,
    setSizePreset,
    submitCurrentDraft: () => submitPrompt(draft, "text"),
    submitSuggestion: (value: string) => submitPrompt(value, "text"),
    loadDatasetPage,
    clearConversation,
    approveHitl,
    rejectHitl,
    requestMoreInfoForHitl,
    openHitl,
    openOperatorRadar: () => {
      radar.openOperatorRadar();
      if (peekMode !== "expanded") void applyPeekMode("expanded");
    },
    dismissOperatorRadar: radar.dismissOperatorRadar,
    snoozeOperatorRadarSignal: radar.snoozeOperatorRadarSignal,
    toggleFollowOperatorRadarSignal: radar.toggleFollowOperatorRadarSignal,
    notifyOperatorRadarSignalOnCompletion: radar.notifyOperatorRadarSignalOnCompletion,
    toggleExpanded,
    openAgent: () => setUiMode("expanded"),
    collapseToPeek: () => setUiMode("peek"),
    setPeekPosition: (position: PeekPosition) => applyPeekPosition(position),
    toggleRecording,
    selectLocale: (nextLocale: LocaleId) => {
      const next = setI18nLocale(nextLocale);
      setLocaleState(next);
    },
    selectTranscriptionProvider: async (provider: TranscriptionProviderId) => {
      const next = await setTranscriptionProvider(provider);
      setTranscriptionProviderState(next);
    },
    retryLastPrompt,
    selectTtsVoice: (voice: string | null) => {
      const normalized = voice?.trim() ?? "";
      const nextVoice = normalized.length > 0 ? normalized : null;
      setSelectedTtsVoiceState(nextVoice);
      storeTtsVoice(nextVoice);
    },
    toggleTts: async () => {
      if (ttsEnabled) {
        await stopSpeechOutput();
      }
      setTtsEnabled((current) => {
        const next = !current;
        storeTtsEnabled(next);
        return next;
      });
    },
    resizeWindow: windowController.resizeWindow,
    startWindowDrag: windowController.startWindowDrag,
  };
}
