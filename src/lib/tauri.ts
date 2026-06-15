import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  BootstrapState,
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRadarResponse,
  DesktopAvatarRadarStreamEvent,
  DesktopAvatarRadarStreamLifecycleEvent,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  HitlDecisionInput,
  HitlDecisionStreamEvent,
  HitlDecisionStreamLifecycleEvent,
  HitlRequestMoreInfoInput,
  TranscriptionProviderChangedEvent,
  TranscriptionProviderId,
  TranscriptionSessionAppendAudioRequest,
  TranscriptionSessionCommitTurnRequest,
  TranscriptionSessionEvent,
  TranscriptionSessionStartRequest,
  TranscriptionSessionStartResult,
  TranscriptionSessionStopRequest,
  PeekMode,
  PeekPosition,
  LocalChatRequest,
  SpeechTranscriptionRequest,
  StreamEnvelope,
  TtsStateEvent
} from "./contracts";
import { t } from "./i18n";
import { DEFAULT_SIZE_PRESET, getWindowSizesForPreset } from "./window-presets";

export const COLLAPSED_SIZE = getWindowSizesForPreset(DEFAULT_SIZE_PRESET).collapsed;
export const EXPANDED_SIZE = getWindowSizesForPreset(DEFAULT_SIZE_PRESET).expanded;

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function requireTauriRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new Error(t("errors.tauriRequired", { feature }));
  }
}

export async function getBootstrapState(): Promise<BootstrapState> {
  if (!isTauriRuntime()) {
    return {
      avatarManifest: null,
      collapsedSize: COLLAPSED_SIZE,
      expandedSize: EXPANDED_SIZE,
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    };
  }

  return invoke<BootstrapState>("load_bootstrap_state");
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_start_drag", { mode: undefined });
}

export async function startWindowDragForMode(mode: PeekMode): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_start_drag", { mode });
}

export async function toggleExpandedWindow(
  expanded: boolean,
  width?: number,
  height?: number,
  collapsedWidth?: number,
  collapsedHeight?: number
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_set_peek_mode", {
    mode: expanded ? "expanded" : "peek",
    width,
    height,
    collapsedWidth,
    collapsedHeight,
    animated: false
  });
}

export async function setPeekMode(
  mode: PeekMode,
  width?: number,
  height?: number,
  collapsedWidth?: number,
  collapsedHeight?: number,
  animated = true,
  showIfHidden = false
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_set_peek_mode", {
    mode,
    width,
    height,
    collapsedWidth,
    collapsedHeight,
    animated,
    showIfHidden
  });
}

export async function setPeekPosition(position: PeekPosition): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_set_peek_position", { position });
}

export type WindowResizeAnchor = "left" | "right";

export async function resizeWindow(
  width: number,
  height: number,
  anchor: WindowResizeAnchor = "left"
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("window_resize", { width, height, anchor });
}

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
}

export async function getWindowGeometry(): Promise<WindowGeometry | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return invoke<WindowGeometry>("window_get_geometry");
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
  requireTauriRuntime("SYNTRA Assistant Anfrage");
  return invoke<CreateDesktopAvatarRequestResult>("desktop_avatar_request_create", { request });
}

export async function getDesktopAvatarRequest(args: {
  avatarRequestId?: string;
  pollUrl?: string;
}): Promise<DesktopAvatarRequestDocument> {
  requireTauriRuntime("SYNTRA Assistant Polling");
  return invoke<DesktopAvatarRequestDocument>("desktop_avatar_request_get", args);
}

export async function getDesktopAvatarRadar(): Promise<DesktopAvatarRadarResponse> {
  requireTauriRuntime("Operator-Radar");
  return invoke<DesktopAvatarRadarResponse>("desktop_avatar_radar_get");
}

export async function startDesktopAvatarRadarStream(): Promise<void> {
  requireTauriRuntime("Operator-Radar Stream");
  await invoke("desktop_avatar_radar_stream_start");
}

export async function stopDesktopAvatarRadarStream(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("desktop_avatar_radar_stream_stop");
}

export async function startDesktopAvatarStream(args: {
  avatarRequestId?: string;
  streamUrl?: string;
}): Promise<void> {
  requireTauriRuntime("SYNTRA Assistant Stream");
  await invoke("desktop_avatar_request_stream", args);
}

export async function stopDesktopAvatarStream(avatarRequestId: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("desktop_avatar_request_stream_stop", { avatarRequestId });
}

export async function startHitlDecisionStream(): Promise<void> {
  requireTauriRuntime("HITL Stream");
  await invoke("hitl_decision_stream_start");
}

export async function stopHitlDecisionStream(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("hitl_decision_stream_stop");
}

export async function approveHitlDecision(input: HitlDecisionInput): Promise<void> {
  requireTauriRuntime("HITL Approval");
  await invoke("hitl_decision_approve", { input });
}

export async function rejectHitlDecision(input: HitlDecisionInput): Promise<void> {
  requireTauriRuntime("HITL Ablehnung");
  await invoke("hitl_decision_reject", { input });
}

export async function requestMoreInfoForHitl(
  input: HitlRequestMoreInfoInput
): Promise<void> {
  requireTauriRuntime("HITL Rueckfrage");
  await invoke("hitl_request_more_info", { input });
}

export async function sendLocalChat(request: LocalChatRequest): Promise<void> {
  requireTauriRuntime("Lokaler Chat");
  await invoke("chat_send_local", { request });
}

export async function transcribeAudio(
  request: SpeechTranscriptionRequest
): Promise<string> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invoke<string>("speech_transcribe", { request });
}

export async function getTranscriptionProvider(): Promise<TranscriptionProviderId> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invoke<TranscriptionProviderId>("transcription_provider_get");
}

export async function setTranscriptionProvider(
  provider: TranscriptionProviderId
): Promise<TranscriptionProviderId> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invoke<TranscriptionProviderId>("transcription_provider_set", { provider });
}

export async function startTranscriptionSession(
  request: TranscriptionSessionStartRequest
): Promise<TranscriptionSessionStartResult> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invoke<TranscriptionSessionStartResult>("transcription_session_start", { request });
}

export async function appendTranscriptionAudio(
  request: TranscriptionSessionAppendAudioRequest
): Promise<void> {
  requireTauriRuntime(t("features.voiceTranscription"));
  await invoke("transcription_session_append_audio", { request });
}

export async function commitTranscriptionTurn(
  request: TranscriptionSessionCommitTurnRequest
): Promise<string> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invoke<string>("transcription_session_commit_turn", { request });
}

export async function stopTranscriptionSession(
  request: TranscriptionSessionStopRequest
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("transcription_session_stop", { request });
}

export async function listTtsVoices(): Promise<string[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  return invoke<string[]>("tts_list_voices");
}

export async function speakText(
  requestId: string,
  text: string,
  voice?: string | null
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("tts_speak", {
    requestId,
    text,
    voice: voice?.trim() ? voice : null
  });
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

export function onDesktopAvatarRadarStreamEvent(
  listener: (event: DesktopAvatarRadarStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarRadarStreamEvent>(
    "desktop-avatar-radar-stream-event",
    ({ payload }) => listener(payload)
  );
}

export function onDesktopAvatarRadarStreamLifecycle(
  listener: (event: DesktopAvatarRadarStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarRadarStreamLifecycleEvent>(
    "desktop-avatar-radar-stream-lifecycle",
    ({ payload }) => listener(payload)
  );
}

export function onHitlDecisionStreamEvent(
  listener: (event: HitlDecisionStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<HitlDecisionStreamEvent>("hitl-decision-stream-event", ({ payload }) =>
    listener(payload)
  );
}

export function onHitlDecisionStreamLifecycle(
  listener: (event: HitlDecisionStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<HitlDecisionStreamLifecycleEvent>(
    "hitl-decision-stream-lifecycle",
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

export function onTranscriptionSessionEvent(
  listener: (event: TranscriptionSessionEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<TranscriptionSessionEvent>("transcription-stream-event", ({ payload }) =>
    listener(payload)
  );
}

export function onTranscriptionProviderChanged(
  listener: (event: TranscriptionProviderChangedEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<TranscriptionProviderChangedEvent>(
    "transcription-provider-changed",
    ({ payload }) => listener(payload)
  );
}

export function onTrayPeekOpen(listener: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen("peek-open", () => listener());
}

export function onTrayPeekCollapse(listener: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen("peek-collapse", () => listener());
}

export function onTrayPeekPositionChanged(
  listener: (position: PeekPosition) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<PeekPosition>("peek-position-changed", ({ payload }) => listener(payload));
}
