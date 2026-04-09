import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AvatarManifest,
  ChatMessage,
  CompanionState,
  CreateDesktopAvatarRequestInput,
  LocalChatMessageInput,
  LocalChatRequest,
  MessageSource,
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
import {
  getBootstrapState,
  onStreamEvent,
  onTtsState,
  resizeWindow,
  sendLocalChat,
  setClickThrough,
  speakText,
  startWindowDrag,
  stopSpeaking,
  toggleExpandedWindow,
  transcribeAudio
} from "../lib/tauri";
import {
  DEFAULT_SIZE_PRESET,
  type SizePreset,
  getWindowSizesForPreset,
  readStoredSizePreset,
  storeSizePreset
} from "../lib/window-presets";

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
      content:
        "You are Milk, a concise desktop companion. Stay conversational, helpful, and never invent business facts."
    },
    ...history
  ];
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

function nextPollDelay(attempt: number): number {
  if (attempt <= 0) {
    return 500;
  }
  if (attempt === 1) {
    return 1000;
  }
  return 2000;
}

export function useDesktopCompanion() {
  const [avatarManifest, setAvatarManifest] = useState<AvatarManifest | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [sizePreset, setSizePresetState] = useState<SizePreset>(() => readStoredSizePreset());
  const [windowSize, setWindowSize] = useState(
    () => getWindowSizesForPreset(DEFAULT_SIZE_PRESET).collapsed
  );
  const [isRecording, setIsRecording] = useState(false);
  const [desktopAvatarState, desktopAvatarDispatch] = useReducer(
    reduceDesktopAvatarState,
    desktopAvatarInitialState
  );

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

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    desktopAvatarStateRef.current = desktopAvatarState;
  }, [desktopAvatarState]);

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

      const poll = async () => {
        const activeRequest = activeDesktopAvatarRequestRef.current;
        if (!activeRequest || activeRequest.avatarRequestId !== avatarRequestId) {
          return;
        }

        try {
          const document = await desktopAvatarApiClient.getRequest({ avatarRequestId, pollUrl });
          desktopAvatarPollErrorCountRef.current = 0;
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
              : "Polling fallback failed.";
          if (desktopAvatarPollErrorCountRef.current >= 3) {
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
    [clearDesktopAvatarPolling]
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
    },
    [clearDesktopAvatarPolling, closeDesktopAvatarConnection, startDesktopAvatarPolling]
  );

  useEffect(() => {
    let unlistenStream: (() => void) | undefined;
    let unlistenTts: (() => void) | undefined;

    void getBootstrapState().then((bootstrap) => {
      setAvatarManifest(bootstrap.avatarManifest);
      setTtsEnabled(bootstrap.ttsEnabled);
      const presetSizes = getWindowSizesForPreset(sizePreset);
      setWindowSize(presetSizes.collapsed);
      void resizeWindow(presetSizes.collapsed.width, presetSizes.collapsed.height);
    });

    void onStreamEvent((event) => {
      void handleLocalStreamEvent(event);
    }).then((unlisten) => {
      unlistenStream = unlisten;
    });

    void onTtsState((event) => {
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

    return () => {
      unlistenStream?.();
      unlistenTts?.();
      void cleanupDesktopAvatarRuntime();
    };
  }, [cleanupDesktopAvatarRuntime, sizePreset]);

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
      void speakText(activeRequest.avatarRequestId, desktopAvatarState.talkText);
    }
  }, [desktopAvatarState.talkText, ttsEnabled]);

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

    if (event.kind === "handoff_local") {
      const context = requestContextsRef.current.get(event.requestId);
      if (!context) {
        return;
      }

      setStatus("Continuing locally…");
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
      requestContextsRef.current.delete(event.requestId);
      activeLocalRequestIdRef.current = null;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? {
                ...message,
                text: payload.displayText,
                isStreaming: false,
                widget: null,
                followUpQuestions: []
              }
            : message
        )
      );
      setStatus(null);
      if (ttsEnabled) {
        await speakText(event.requestId, payload.speechText);
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

  async function submitDesktopAvatarPrompt(
    prompt: string,
    source: MessageSource,
    route: PromptRoute,
    clientRequestId?: string
  ) {
    const requestId = clientRequestId ?? `desktop-avatar-client:${crypto.randomUUID()}`;
    const userMessage = buildUserMessage(prompt, source);
    const assistantMessage = buildAssistantPlaceholder(source, requestId);
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    setError(null);
    setStatus("Sending request…");
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

    if (!isExpanded) {
      await toggleExpanded();
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
      desktopAvatarDispatch({ type: "createAccepted", result });
      await connectDesktopAvatarStream(result.avatarRequestId, result.streamUrl, result.pollUrl);
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "The request could not be started.";
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
      await stopSpeaking();
      await cleanupDesktopAvatarRuntime();
      const userMessage = buildUserMessage(prompt, source);
      const assistantMessage = buildAssistantPlaceholder(source);
      const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setDraft("");
      requestContextsRef.current.set(assistantMessage.id, { prompt, source, route });
      activeLocalRequestIdRef.current = assistantMessage.id;
      activeDesktopAvatarRequestRef.current = null;
      desktopAvatarDispatch({ type: "reset" });

      if (!isExpanded) {
        await toggleExpanded();
      }

      setCompanionState("thinking");
      setStatus("Thinking locally…");

      try {
        const request: LocalChatRequest = {
          requestId: assistantMessage.id,
          prompt,
          messages: buildLocalHistory(nextMessages)
        };
        await sendLocalChat(request);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error ? caughtError.message : "The request could not be started.";
        await handleLocalStreamEvent({
          requestId: assistantMessage.id,
          source: "local",
          kind: "error",
          payload: { message }
        });
      }
      return;
    }

    await submitDesktopAvatarPrompt(prompt, source, route, retryClientRequestId);
  }

  async function toggleExpanded() {
    const nextExpanded = !isExpanded;
    const presetSizes = getWindowSizesForPreset(sizePreset);
    const targetSize = nextExpanded ? presetSizes.expanded : presetSizes.collapsed;
    setIsExpanded(nextExpanded);
    await toggleExpandedWindow(nextExpanded, targetSize.width, targetSize.height);
    setWindowSize(targetSize);
    if (nextExpanded) {
      await setClickThrough(false);
    }
  }

  async function setSizePreset(preset: SizePreset) {
    if (preset === sizePreset) {
      return;
    }

    const presetSizes = getWindowSizesForPreset(preset);
    setSizePresetState(preset);
    storeSizePreset(preset);

    const targetSize = isExpanded ? presetSizes.expanded : presetSizes.collapsed;
    await resizeWindow(targetSize.width, targetSize.height);
    setWindowSize(targetSize);
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
          setStatus("Transcribing…");
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
              : "Voice transcription failed.";
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
      setStatus("Listening…");
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "Microphone access failed.";
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

  return {
    avatarManifest,
    canSend,
    companionState,
    draft,
    error,
    isExpanded,
    isRecording,
    messages,
    status,
    sizePreset,
    ttsEnabled,
    windowSize,
    activeAnimation: activeDesktopAvatarRequestRef.current
      ? desktopAvatarState.animation
      : null,
    setDraft,
    setSizePreset,
    submitCurrentDraft: () => submitPrompt(draft, "text"),
    submitSuggestion: (value: string) => submitPrompt(value, "text"),
    toggleExpanded,
    toggleRecording,
    retryLastPrompt,
    toggleTts: async () => {
      if (ttsEnabled) {
        await stopSpeaking();
      }
      setTtsEnabled((current) => !current);
    },
    resizeWindow: async (width: number, height: number) => {
      await resizeWindow(width, height);
      setWindowSize({ width, height });
    },
    startWindowDrag
  };
}
