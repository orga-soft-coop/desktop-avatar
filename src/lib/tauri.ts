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
  SpeechTranscriptionRequest,
  TtsStateEvent
} from "./contracts";
import type {
  AuthBranchSummary,
  AuthCompanySummary,
  AuthPreauthenticateResult,
  DesktopAvatarTenantSession
} from "./auth-contracts";
import {
  clearTenantSession,
  getRequiredTenantContextId,
  isCurrentTenantContext
} from "./tenant-session";
import { isAgentStudioSessionInvalid } from "./auth-errors";
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

const TENANT_SESSION_INVALIDATED_EVENT = "desktop-avatar-session-invalidated";

function resolveExpectedContextId(capturedContextId?: string): string {
  if (capturedContextId) {
    if (!isCurrentTenantContext(capturedContextId)) {
      throw new Error("DESKTOP_SESSION_CHANGED");
    }
    return capturedContextId;
  }
  return getRequiredTenantContextId();
}

function invalidateTenantSessionFromApi(error: unknown): void {
  if (!isAgentStudioSessionInvalid(error)) return;
  clearTenantSession();
  window.dispatchEvent(new Event(TENANT_SESSION_INVALIDATED_EVENT));
  void invoke("auth_session_get").catch(() => undefined);
}

async function invokeTenant<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    invalidateTenantSessionFromApi(error);
    throw error;
  }
}

export function onTenantSessionInvalidated(listener: () => void): () => void {
  window.addEventListener(TENANT_SESSION_INVALIDATED_EVENT, listener);
  return () => window.removeEventListener(TENANT_SESSION_INVALIDATED_EVENT, listener);
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

export async function authPreauthenticate(
  username: string,
  password: string
): Promise<AuthPreauthenticateResult> {
  requireTauriRuntime("Agent Studio Login");
  return invoke<AuthPreauthenticateResult>("auth_preauthenticate", {
    input: { username, password }
  });
}

export async function authCompanies(): Promise<AuthCompanySummary[]> {
  requireTauriRuntime("Agent Studio Login");
  return invoke<AuthCompanySummary[]>("auth_companies");
}

export async function authBranches(companyId: string): Promise<AuthBranchSummary[]> {
  requireTauriRuntime("Agent Studio Login");
  return invoke<AuthBranchSummary[]>("auth_branches", { companyId });
}

export async function authComplete(
  companyId: string,
  branchId: string
): Promise<DesktopAvatarTenantSession> {
  requireTauriRuntime("Agent Studio Login");
  return invoke<DesktopAvatarTenantSession>("auth_complete", {
    input: { companyId, branchId }
  });
}

export async function authSessionGet(): Promise<DesktopAvatarTenantSession> {
  requireTauriRuntime("Agent Studio Session");
  return invoke<DesktopAvatarTenantSession>("auth_session_get");
}

export async function authLogout(): Promise<void> {
  requireTauriRuntime("Agent Studio Logout");
  await invoke("auth_logout");
}

export async function createDesktopAvatarRequest(
  request: CreateDesktopAvatarRequestInput,
  capturedContextId?: string
): Promise<CreateDesktopAvatarRequestResult> {
  requireTauriRuntime("SYNTRA Assistant Anfrage");
  return invokeTenant<CreateDesktopAvatarRequestResult>("desktop_avatar_request_create", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function getDesktopAvatarRequest(args: {
  avatarRequestId?: string;
  pollUrl?: string;
}, capturedContextId?: string): Promise<DesktopAvatarRequestDocument> {
  requireTauriRuntime("SYNTRA Assistant Polling");
  return invokeTenant<DesktopAvatarRequestDocument>("desktop_avatar_request_get", {
    ...args,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function getDesktopAvatarRadar(
  capturedContextId?: string
): Promise<DesktopAvatarRadarResponse> {
  requireTauriRuntime("Operator-Radar");
  return invokeTenant<DesktopAvatarRadarResponse>("desktop_avatar_radar_get", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function startDesktopAvatarRadarStream(capturedContextId?: string): Promise<void> {
  requireTauriRuntime("Operator-Radar Stream");
  await invokeTenant("desktop_avatar_radar_stream_start", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function stopDesktopAvatarRadarStream(capturedContextId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("desktop_avatar_radar_stream_stop", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function startDesktopAvatarStream(args: {
  avatarRequestId?: string;
  streamUrl?: string;
}, capturedContextId?: string): Promise<void> {
  requireTauriRuntime("SYNTRA Assistant Stream");
  await invokeTenant("desktop_avatar_request_stream", {
    ...args,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function stopDesktopAvatarStream(
  avatarRequestId: string,
  capturedContextId?: string
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("desktop_avatar_request_stream_stop", {
    avatarRequestId,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function startHitlDecisionStream(capturedContextId?: string): Promise<void> {
  requireTauriRuntime("HITL Stream");
  await invokeTenant("hitl_decision_stream_start", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function stopHitlDecisionStream(capturedContextId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("hitl_decision_stream_stop", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function approveHitlDecision(
  input: HitlDecisionInput,
  capturedContextId?: string
): Promise<void> {
  requireTauriRuntime("HITL Approval");
  await invokeTenant("hitl_decision_approve", {
    input,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function rejectHitlDecision(
  input: HitlDecisionInput,
  capturedContextId?: string
): Promise<void> {
  requireTauriRuntime("HITL Ablehnung");
  await invokeTenant("hitl_decision_reject", {
    input,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function requestMoreInfoForHitl(
  input: HitlRequestMoreInfoInput,
  capturedContextId?: string
): Promise<void> {
  requireTauriRuntime("HITL Rueckfrage");
  await invokeTenant("hitl_request_more_info", {
    input,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function transcribeAudio(
  request: SpeechTranscriptionRequest,
  capturedContextId?: string
): Promise<string> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invokeTenant<string>("speech_transcribe", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
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
  request: TranscriptionSessionStartRequest,
  capturedContextId?: string
): Promise<TranscriptionSessionStartResult> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invokeTenant<TranscriptionSessionStartResult>("transcription_session_start", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function appendTranscriptionAudio(
  request: TranscriptionSessionAppendAudioRequest,
  capturedContextId?: string
): Promise<void> {
  requireTauriRuntime(t("features.voiceTranscription"));
  await invokeTenant("transcription_session_append_audio", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function commitTranscriptionTurn(
  request: TranscriptionSessionCommitTurnRequest,
  capturedContextId?: string
): Promise<string> {
  requireTauriRuntime(t("features.voiceTranscription"));
  return invokeTenant<string>("transcription_session_commit_turn", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function stopTranscriptionSession(
  request: TranscriptionSessionStopRequest,
  capturedContextId?: string
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("transcription_session_stop", {
    request,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
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
  voice?: string | null,
  capturedContextId?: string
): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("tts_speak", {
    requestId,
    text,
    voice: voice?.trim() ? voice : null,
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export async function stopSpeaking(capturedContextId?: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invokeTenant("tts_stop", {
    expectedContextId: resolveExpectedContextId(capturedContextId)
  });
}

export function onDesktopAvatarStreamEvent(
  listener: (event: DesktopAvatarStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarStreamEvent & { contextId?: string }>(
    "desktop-avatar-stream-event",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) listener(payload);
    }
  );
}

export function onDesktopAvatarStreamLifecycle(
  listener: (event: DesktopAvatarStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarStreamLifecycleEvent & { contextId?: string }>(
    "desktop-avatar-stream-lifecycle",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) {
        invalidateTenantSessionFromApi(payload.reason);
        listener(payload);
      }
    }
  );
}

export function onDesktopAvatarRadarStreamEvent(
  listener: (event: DesktopAvatarRadarStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarRadarStreamEvent & { contextId?: string }>(
    "desktop-avatar-radar-stream-event",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) listener(payload);
    }
  );
}

export function onDesktopAvatarRadarStreamLifecycle(
  listener: (event: DesktopAvatarRadarStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<DesktopAvatarRadarStreamLifecycleEvent & { contextId?: string }>(
    "desktop-avatar-radar-stream-lifecycle",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) {
        invalidateTenantSessionFromApi(payload.reason);
        listener(payload);
      }
    }
  );
}

export function onHitlDecisionStreamEvent(
  listener: (event: HitlDecisionStreamEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<HitlDecisionStreamEvent & { contextId?: string }>(
    "hitl-decision-stream-event",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) listener(payload);
    }
  );
}

export function onHitlDecisionStreamLifecycle(
  listener: (event: HitlDecisionStreamLifecycleEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<HitlDecisionStreamLifecycleEvent & { contextId?: string }>(
    "hitl-decision-stream-lifecycle",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) {
        invalidateTenantSessionFromApi(payload.reason);
        listener(payload);
      }
    }
  );
}

export function onTtsState(
  listener: (event: TtsStateEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<TtsStateEvent & { contextId?: string }>("tts-state", ({ payload }) => {
    if (isCurrentTenantContext(payload.contextId)) listener(payload);
  });
}

export function onTranscriptionSessionEvent(
  listener: (event: TranscriptionSessionEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => {});
  }
  return listen<TranscriptionSessionEvent & { contextId?: string }>(
    "transcription-stream-event",
    ({ payload }) => {
      if (isCurrentTenantContext(payload.contextId)) listener(payload);
    }
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
