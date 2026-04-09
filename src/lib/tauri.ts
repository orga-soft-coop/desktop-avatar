import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BootstrapState,
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  LocalChatRequest,
  SpeechTranscriptionRequest,
  StreamEnvelope,
  TtsStateEvent
} from "./contracts";
import { DEFAULT_SIZE_PRESET, getWindowSizesForPreset } from "./window-presets";

export const COLLAPSED_SIZE = getWindowSizesForPreset(DEFAULT_SIZE_PRESET).collapsed;
export const EXPANDED_SIZE = getWindowSizesForPreset(DEFAULT_SIZE_PRESET).expanded;

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function requireTauriRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} requires the Tauri desktop shell.`);
  }
}

export async function getBootstrapState(): Promise<BootstrapState> {
  if (!isTauriRuntime()) {
    return {
      avatarManifest: null,
      collapsedSize: COLLAPSED_SIZE,
      expandedSize: EXPANDED_SIZE,
      ttsEnabled: true
    };
  }

  return invoke<BootstrapState>("load_bootstrap_state");
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_start_drag");
}

export async function toggleExpandedWindow(
  expanded: boolean,
  width?: number,
  height?: number
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_toggle_expanded", { expanded, width, height });
}

export async function resizeWindow(width: number, height: number): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_resize", { width, height });
}

export async function setClickThrough(ignore: boolean): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_set_click_through", { ignore });
}

export async function loadAvatarAsset(path: string): Promise<string> {
  if (!isTauriRuntime()) {
    if (/^(https?:|blob:|data:)/i.test(path) || /^(\/(?!\/)|\.{1,2}\/)/.test(path)) {
      return path;
    }
    return convertFileSrc(path);
  }

  const response = await invoke<{ mimeType: string; base64: string }>("load_avatar_asset", {
    path
  });
  const binary = atob(response.base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: response.mimeType });
  return URL.createObjectURL(blob);
}

export async function frontendLog(level: string, message: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("frontend_log", { level, message });
}

export async function createDesktopAvatarRequest(
  request: CreateDesktopAvatarRequestInput
): Promise<CreateDesktopAvatarRequestResult> {
  requireTauriRuntime("Desktop Avatar request");
  return invoke<CreateDesktopAvatarRequestResult>("desktop_avatar_request_create", { request });
}

export async function getDesktopAvatarRequest(args: {
  avatarRequestId?: string;
  pollUrl?: string;
}): Promise<DesktopAvatarRequestDocument> {
  requireTauriRuntime("Desktop Avatar polling");
  return invoke<DesktopAvatarRequestDocument>("desktop_avatar_request_get", args);
}

export async function startDesktopAvatarStream(args: {
  avatarRequestId?: string;
  streamUrl?: string;
}): Promise<void> {
  requireTauriRuntime("Desktop Avatar stream");
  await invoke("desktop_avatar_request_stream", args);
}

export async function stopDesktopAvatarStream(avatarRequestId: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("desktop_avatar_request_stream_stop", { avatarRequestId });
}

export async function sendLocalChat(request: LocalChatRequest): Promise<void> {
  requireTauriRuntime("Local chat");
  await invoke("chat_send_local", { request });
}

export async function transcribeAudio(
  request: SpeechTranscriptionRequest
): Promise<string> {
  requireTauriRuntime("Voice transcription");
  return invoke<string>("speech_transcribe", { request });
}

export async function speakText(requestId: string, text: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("tts_speak", { requestId, text });
}

export async function stopSpeaking(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("tts_stop");
}

export function onStreamEvent(
  listener: (event: StreamEnvelope) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<StreamEnvelope>("chat-stream-event", ({ payload }) => listener(payload));
}

export function onDesktopAvatarStreamEvent(
  listener: (event: DesktopAvatarStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarStreamEvent>("desktop-avatar-stream-event", ({ payload }) =>
    listener(payload)
  );
}

export function onDesktopAvatarStreamLifecycle(
  listener: (event: DesktopAvatarStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarStreamLifecycleEvent>(
    "desktop-avatar-stream-lifecycle",
    ({ payload }) => listener(payload)
  );
}

export function onTtsState(
  listener: (event: TtsStateEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<TtsStateEvent>("tts-state", ({ payload }) => listener(payload));
}
