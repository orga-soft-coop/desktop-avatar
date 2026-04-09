import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AvatarManifest,
  BusinessCardPayload,
  BusinessChatRequest,
  ChatMessage,
  CompanionState,
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
import { routePrompt } from "../lib/router";
import {
  getBootstrapState,
  onStreamEvent,
  onTtsState,
  resizeWindow,
  sendBusinessChat,
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

interface RequestContext {
  prompt: string;
  source: MessageSource;
  route: PromptRoute;
}

function buildAssistantPlaceholder(source: MessageSource): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    source,
    isStreaming: true
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

export function useDesktopCompanion() {
  const [avatarManifest, setAvatarManifest] = useState<AvatarManifest | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [conversationId] = useState(() => crypto.randomUUID());
  const [sizePreset, setSizePresetState] = useState<SizePreset>(() => readStoredSizePreset());
  const [windowSize, setWindowSize] = useState(
    () => getWindowSizesForPreset(DEFAULT_SIZE_PRESET).collapsed
  );
  const [isRecording, setIsRecording] = useState(false);

  const requestContextsRef = useRef(new Map<string, RequestContext>());
  const messagesRef = useRef<ChatMessage[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const lastPromptRef = useRef<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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
      handleStreamEvent(event);
    }).then((unlisten) => {
      unlistenStream = unlisten;
    });

    void onTtsState((event) => {
      if (event.speaking) {
        setCompanionState("speaking");
      } else if (!activeRequestIdRef.current) {
        setCompanionState("idle");
        setStatus(null);
      }
    }).then((unlisten) => {
      unlistenTts = unlisten;
    });

    return () => {
      unlistenStream?.();
      unlistenTts?.();
    };
  }, []);

  async function handleStreamEvent(event: StreamEnvelope) {
    activeRequestIdRef.current = event.requestId;

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
      activeRequestIdRef.current = null;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? {
                ...message,
                text: payload.displayText,
                card: payload.card as BusinessCardPayload | undefined,
                isStreaming: false
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
      activeRequestIdRef.current = null;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? {
                ...message,
                text: payload.message,
                card: {
                  type: "error",
                  title: "Request failed",
                  subtitle: payload.retryHint ?? undefined,
                  data: {
                    message: payload.message,
                    retryHint: payload.retryHint
                  }
                },
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

  async function submitPrompt(rawPrompt: string, source: MessageSource) {
    const prompt = rawPrompt.trim();
    if (!prompt) {
      return;
    }

    lastPromptRef.current = prompt;
    setError(null);
    await stopSpeaking();

    const route = routePrompt(prompt);
    const userMessage = buildUserMessage(prompt, source);
    const assistantMessage = buildAssistantPlaceholder(source);
    const nextMessages = [...messagesRef.current, userMessage, assistantMessage];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setDraft("");
    requestContextsRef.current.set(assistantMessage.id, { prompt, source, route });
    activeRequestIdRef.current = assistantMessage.id;

    if (!isExpanded) {
      await toggleExpanded();
    }

    setCompanionState("thinking");
    setStatus(route === "localChat" ? "Thinking locally…" : "Checking with the Communication Officer…");

    try {
      if (route === "localChat") {
        const request: LocalChatRequest = {
          requestId: assistantMessage.id,
          prompt,
          messages: buildLocalHistory(nextMessages)
        };
        await sendLocalChat(request);
      } else {
        const request: BusinessChatRequest = {
          requestId: assistantMessage.id,
          conversationId,
          utterance: prompt,
          source,
          locale: navigator.language,
          route
        };
        await sendBusinessChat(request);
      }
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : "The request could not be started.";
      await handleStreamEvent({
        requestId: assistantMessage.id,
        source: route === "localChat" ? "local" : "business",
        kind: "error",
        payload: { message }
      });
    }
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
    if (!lastPromptRef.current) {
      return;
    }
    await submitPrompt(lastPromptRef.current, "text");
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
    setDraft,
    setSizePreset,
    submitCurrentDraft: () => submitPrompt(draft, "text"),
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
