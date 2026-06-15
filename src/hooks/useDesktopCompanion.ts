import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  AvatarManifest,
  ChatMessage,
  CompanionState,
  CreateDesktopAvatarRequestInput,
  BackendConnectionState,
  DesktopAvatarOperatorRadarWidget,
  DesktopAvatarRadarResponse,
  DesktopAvatarRadarSignal,
  DesktopAvatarRadarStreamEvent,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarHitlApprovalWidget,
  DesktopAvatarWidgetPayload,
  DevToolsLatencySnapshot,
  HitlDecisionQueueItem,
  HitlDecisionStreamEvent,
  LocalChatMessageInput,
  LocalChatRequest,
  MessageSource,
  PeekMode,
  PeekPosition,
  PromptRoute,
  TranscriptionProviderId,
  StreamDeltaPayload,
  StreamEnvelope,
  StreamErrorPayload,
  StreamFinalPayload,
  StreamTextPayload,
} from "../lib/contracts";
import {
  desktopAvatarApiClient,
  type HitlDecisionStreamConnection,
  type DesktopAvatarStreamConnection,
  type DesktopAvatarRadarStreamConnection,
} from "../lib/desktop-avatar-api";
import {
  desktopAvatarInitialState,
  reduceDesktopAvatarState,
  type DesktopAvatarOrchestratorState,
  isDesktopAvatarTerminalStatus,
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
  appendTranscriptionAudio,
  commitTranscriptionTurn,
  getTranscriptionProvider,
  getBootstrapState,
  listTtsVoices,
  onTranscriptionProviderChanged,
  onTranscriptionSessionEvent,
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
  startTranscriptionSession,
  stopTranscriptionSession,
  setTranscriptionProvider,
  type WindowResizeAnchor,
} from "../lib/tauri";
import {
  DEFAULT_SIZE_PRESET,
  type SizePreset,
  getWindowSizesForPreset,
  readStoredSizePreset,
  storeSizePreset,
} from "../lib/window-presets";

const TTS_VOICE_STORAGE_KEY = "desktop-avatar.ttsVoice";
const TTS_ENABLED_STORAGE_KEY = "desktop-avatar.ttsEnabled";
const PEEK_MODE_STORAGE_KEY = "desktop-avatar.peekMode";
const PEEK_POSITION_STORAGE_KEY = "desktop-avatar.peekPosition";
const PEEK_ANIMATION_ENABLED_STORAGE_KEY =
  "desktop-avatar.peekAnimationEnabled";
const LAST_EXPANDED_SIZE_STORAGE_KEY = "desktop-avatar.lastExpandedSize";
const DEFAULT_PEEK_MODE: PeekMode = "peek";
const DEFAULT_PEEK_POSITION: PeekPosition = "top-right";
const MODE_TRANSITION_COLLAPSE_OUT_MS = 210;
const MODE_TRANSITION_EXPAND_REVEAL_MS = 240;
const MODE_TRANSITION_PEEK_REVEAL_MS = 220;
const MODE_TRANSITION_PEEK_OUT_MS = 190;
const VOICE_MAX_RECORDING_MS = 20_000;
const VOICE_SILENCE_HOLD_MS = 2_200;
const VOICE_ACTIVITY_POLL_MS = 120;
const VOICE_SILENCE_RMS_THRESHOLD = 0.01;
const VOICE_SPEECH_RMS_THRESHOLD = 0.012;
const VOICE_MIN_AUTOSTOP_ELAPSED_MS = 2_400;
const VOICE_MAX_INITIAL_SILENCE_MS = 7_000;
const VOICE_MIN_TRANSCRIPTION_MS = 700;
const VOICE_MIN_TRANSCRIPTION_BYTES = 1_500;
const VOICE_TRANSCRIPT_PREVIEW_MS = 2200;
const VOICE_PCM_SAMPLE_RATE = 24_000;
const VOICE_STT_CHUNK_BYTES = 12 * 1024;
const HITL_STREAM_RECONNECT_MS = 5_000;
const HITL_ANNOUNCEMENT_BATCH_MS = 250;
const OPERATOR_RADAR_POLL_MS = 15_000;
const OPERATOR_RADAR_STREAM_RECONNECT_MS = 5_000;
const OPERATOR_RADAR_SNOOZE_MS = 10 * 60_000;
const LEGACY_OPENAI_TTS_DEFAULT_VOICE = "onyx";
const PREFERRED_OPENAI_TTS_DEFAULT_VOICE = "shimmer";

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

function buildLocalHistory(messages: ChatMessage[]): LocalChatMessageInput[] {
  const systemPrompt = t("localChat.systemPrompt");
  const history = messages
    .filter((message) => message.role !== "system" && message.text.trim())
    .map<LocalChatMessageInput>((message) => ({
      role: message.role,
      content: message.text,
    }));

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    ...history,
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

  const fullPromptPattern = new RegExp(
    escapeRegExp(t("localChat.systemPrompt")),
    "gi",
  );
  sanitized = sanitized.replace(fullPromptPattern, "").trim();

  const prefixPattern =
    /^you are milk,\s*a concise desktop companion\.[\s\S]{0,260}?(?:instructions?\.?|facts\.?)/i;
  sanitized = sanitized.replace(prefixPattern, "").trim();

  return sanitized;
}

function toHitlWidget(item: HitlDecisionQueueItem): DesktopAvatarHitlApprovalWidget {
  return {
    type: "hitlApproval",
    decisionId: item.decisionId,
    runId: item.runId,
    ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    ...(item.actionId ? { actionId: item.actionId } : {}),
    title: item.title,
    description: item.description,
    agentName: item.agent.agentName,
    mode: item.mode,
    status: item.status,
    priority: item.priority,
    contextSections: item.contextSections,
  };
}

function toOperatorRadarWidget(
  response: DesktopAvatarRadarResponse,
): DesktopAvatarOperatorRadarWidget {
  return {
    type: "operatorRadar",
    title: t("widgets.radar.title"),
    generatedAt: response.generatedAt,
    summary: response.summary,
    items: response.items,
  };
}

interface RadarSignalControl {
  followed?: boolean;
  completionOnly?: boolean;
  snoozedUntilMs?: number;
}

function isRadarCompletionStatus(status: DesktopAvatarRadarSignal["status"]): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

function buildRadarSummaryFromItems(
  response: DesktopAvatarRadarResponse,
  items: DesktopAvatarRadarSignal[],
): DesktopAvatarRadarResponse["summary"] {
  return {
    totalCount: items.length,
    criticalCount: items.filter((item) => item.severity === "critical").length,
    highCount: items.filter((item) => item.severity === "high").length,
    needsApprovalCount: items.filter((item) => item.status === "needsApproval").length,
    runningCount: items.filter((item) => item.status === "running").length,
    failedCount: items.filter(
      (item) => item.status === "failed" || item.status === "blocked",
    ).length,
    ...(items[0] ? { topSignalId: items[0].signalId } : {}),
    ...(items.length === response.items.length && response.summary.topSignalId
      ? { topSignalId: response.summary.topSignalId }
      : {}),
  };
}

function applyRadarSignalControls(input: {
  response: DesktopAvatarRadarResponse;
  controls: Map<string, RadarSignalControl>;
  nowMs: number;
}): DesktopAvatarRadarResponse {
  const visibleItems: DesktopAvatarRadarSignal[] = [];
  for (const item of input.response.items) {
    const control = input.controls.get(item.signalId);
    if (!control) {
      visibleItems.push(item);
      continue;
    }

    const snoozedUntilMs = control.snoozedUntilMs ?? 0;
    if (snoozedUntilMs > 0 && snoozedUntilMs <= input.nowMs) {
      delete control.snoozedUntilMs;
    }

    const isSnoozed = (control.snoozedUntilMs ?? 0) > input.nowMs;
    const waitsForCompletion =
      Boolean(control.completionOnly) && !isRadarCompletionStatus(item.status);
    if (isSnoozed || waitsForCompletion) {
      continue;
    }

    visibleItems.push({
      ...item,
      clientState: {
        ...(control.followed ? { followed: true } : {}),
        ...(control.completionOnly ? { completionOnly: true } : {}),
        ...(control.snoozedUntilMs
          ? { snoozedUntil: new Date(control.snoozedUntilMs).toISOString() }
          : {}),
      },
    });
  }

  return {
    ...input.response,
    summary: buildRadarSummaryFromItems(input.response, visibleItems),
    items: visibleItems,
  };
}

function upsertHitlWidget(
  widgets: DesktopAvatarHitlApprovalWidget[],
  next: DesktopAvatarHitlApprovalWidget,
): DesktopAvatarHitlApprovalWidget[] {
  const index = widgets.findIndex((widget) => widget.decisionId === next.decisionId);
  if (index < 0) {
    return [...widgets, next];
  }
  return widgets.map((widget, candidateIndex) =>
    candidateIndex === index ? next : widget,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function splitBytesToBase64Chunks(
  bytes: Uint8Array,
  chunkSize = VOICE_STT_CHUNK_BYTES,
): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    chunks.push(bytesToBase64(chunk));
  }
  return chunks;
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  if (value < -1) {
    return -1;
  }
  return value;
}

function readMixedSample(buffer: AudioBuffer, frameIndex: number): number {
  const clampedIndex = Math.max(0, Math.min(buffer.length - 1, frameIndex));
  let sum = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    sum += buffer.getChannelData(channel)[clampedIndex] ?? 0;
  }
  return sum / Math.max(1, buffer.numberOfChannels);
}

function audioBufferToPcm16(buffer: AudioBuffer, targetSampleRate = VOICE_PCM_SAMPLE_RATE): Uint8Array {
  const frameCount = Math.max(
    1,
    Math.round((buffer.length * targetSampleRate) / buffer.sampleRate),
  );
  const pcm = new Uint8Array(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourcePosition = (frame * buffer.sampleRate) / targetSampleRate;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, buffer.length - 1);
    const ratio = sourcePosition - leftIndex;
    const leftSample = readMixedSample(buffer, leftIndex);
    const rightSample = readMixedSample(buffer, rightIndex);
    const interpolated = clampSample(leftSample + (rightSample - leftSample) * ratio);
    const int16 = interpolated < 0 ? interpolated * 0x8000 : interpolated * 0x7fff;
    const signed = Math.max(-32768, Math.min(32767, Math.round(int16)));
    const byteOffset = frame * 2;
    pcm[byteOffset] = signed & 0xff;
    pcm[byteOffset + 1] = (signed >> 8) & 0xff;
  }
  return pcm;
}

async function decodeBlobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

async function prepareTranscriptionUpload(
  blob: Blob,
  provider: TranscriptionProviderId,
): Promise<{ mimeType: string; chunks: string[]; totalBytes: number }> {
  if (provider === "openai-realtime") {
    const audioBuffer = await decodeBlobToAudioBuffer(blob);
    const pcm = audioBufferToPcm16(audioBuffer, VOICE_PCM_SAMPLE_RATE);
    return {
      mimeType: "audio/pcm",
      chunks: splitBytesToBase64Chunks(pcm),
      totalBytes: pcm.length,
    };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    mimeType: blob.type || "audio/webm",
    chunks: splitBytesToBase64Chunks(bytes),
    totalBytes: bytes.length,
  };
}

function preferredMimeType(): string {
  const options = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return (
    options.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ""
  );
}

function buildDesktopAvatarRequestInput(
  prompt: string,
  source: MessageSource,
  clientRequestId: string,
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
    autoStart: true,
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
    if (
      typeof candidate.message === "string" &&
      candidate.message.trim().length > 0
    ) {
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
    normalized.includes(
      "ops routing found no active domain target supporting",
    ) ||
    normalized.includes(
      "no active studio agents available for desktop avatar routing",
    ) ||
    normalized.includes(
      "no active studio agents available for syntra assistant routing",
    ) ||
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
    window.localStorage.setItem(
      PEEK_ANIMATION_ENABLED_STORAGE_KEY,
      String(enabled),
    );
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
      JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
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
  const [avatarManifest, setAvatarManifest] = useState<AvatarManifest | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peekMode, setPeekModeState] = useState<PeekMode>(() =>
    readStoredPeekMode(),
  );
  const [peekPosition, setPeekPositionState] = useState<PeekPosition>(() =>
    readStoredPeekPosition(),
  );
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const [modeTransitionPhase, setModeTransitionPhase] =
    useState<ModeTransitionPhase>("idle");
  const [animationEnabled] = useState<boolean>(() =>
    readStoredAnimationEnabled(),
  );
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
  const [sizePreset, setSizePresetState] = useState<SizePreset>(() =>
    readStoredSizePreset(),
  );
  const [windowSize, setWindowSize] = useState(() => {
    const preset = getWindowSizesForPreset(DEFAULT_SIZE_PRESET);
    return {
      width: preset.expanded.width,
      height: readStoredLastExpandedHeight(preset.expanded.height),
    };
  });
  const [isRecording, setIsRecording] = useState(false);
  const [desktopAvatarState, desktopAvatarDispatch] = useReducer(
    reduceDesktopAvatarState,
    desktopAvatarInitialState,
  );
  const [latencyTimeline, setLatencyTimeline] =
    useState<LatencyTimeline | null>(null);
  const [hitlWidgets, setHitlWidgets] = useState<DesktopAvatarHitlApprovalWidget[]>([]);
  const [operatorRadarWidget, setOperatorRadarWidget] =
    useState<DesktopAvatarWidgetPayload | null>(null);
  const [operatorRadarSignalCount, setOperatorRadarSignalCount] = useState(0);
  const [backendConnectionState, setBackendConnectionState] =
    useState<BackendConnectionState>("connecting");

  const requestContextsRef = useRef(new Map<string, SubmissionContext>());
  const messagesRef = useRef<ChatMessage[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const activeTranscriptionSessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(
    null,
  );
  const recordingAnalyserNodeRef = useRef<AnalyserNode | null>(null);
  const recordingMonitorIntervalRef = useRef<number | null>(null);
  const recordingSilenceSinceMsRef = useRef<number | null>(null);
  const recordingStartedAtMsRef = useRef<number | null>(null);
  const recordingSpeechDetectedRef = useRef(false);
  const recordingAutoStopReasonRef = useRef<
    "manual" | "silence" | "limit" | null
  >(null);
  const lastSubmissionRef = useRef<SubmissionContext | null>(null);
  const conversationEpochRef = useRef(0);
  const activeLocalRequestIdRef = useRef<string | null>(null);
  const activeDesktopAvatarRequestRef =
    useRef<ActiveDesktopAvatarRequest | null>(null);
  const desktopAvatarStateRef = useRef<DesktopAvatarOrchestratorState>(
    desktopAvatarInitialState,
  );
  const desktopAvatarConnectionRef =
    useRef<DesktopAvatarStreamConnection | null>(null);
  const hitlDecisionConnectionRef =
    useRef<HitlDecisionStreamConnection | null>(null);
  const operatorRadarConnectionRef =
    useRef<DesktopAvatarRadarStreamConnection | null>(null);
  const announcedHitlDecisionIdsRef = useRef(new Set<string>());
  const operatorRadarVisibleRef = useRef(false);
  const operatorRadarLastResponseRef = useRef<DesktopAvatarRadarResponse | null>(null);
  const operatorRadarSignalControlsRef = useRef(new Map<string, RadarSignalControl>());
  const pendingHitlAnnouncementsRef = useRef(
    new Map<string, DesktopAvatarHitlApprovalWidget>(),
  );
  const hitlAnnouncementTimeoutRef = useRef<number | null>(null);
  const locallySubmittedHitlDecisionIdsRef = useRef(new Set<string>());
  const desktopAvatarPollTimeoutRef = useRef<number | null>(null);
  const desktopAvatarPollAttemptRef = useRef(0);
  const desktopAvatarPollErrorCountRef = useRef(0);
  const lastSpokenDesktopAvatarKeyRef = useRef<string | null>(null);
  const isTtsSpeakingRef = useRef(false);
  const peekModeRef = useRef<PeekMode>(peekMode);
  const ttsEnabledRef = useRef(ttsEnabled);
  const selectedTtsVoiceRef = useRef(selectedTtsVoice);

  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    selectedTtsVoiceRef.current = selectedTtsVoice;
  }, [selectedTtsVoice]);

  useEffect(() => {
    function clearHitlAnnouncementTimeout(): void {
      if (hitlAnnouncementTimeoutRef.current === null) {
        return;
      }
      window.clearTimeout(hitlAnnouncementTimeoutRef.current);
      hitlAnnouncementTimeoutRef.current = null;
    }

    function flushHitlAnnouncements(): void {
      hitlAnnouncementTimeoutRef.current = null;
      const widgets = Array.from(pendingHitlAnnouncementsRef.current.values());
      pendingHitlAnnouncementsRef.current.clear();
      if (widgets.length === 0) {
        return;
      }

      const announcement =
        widgets.length === 1
          ? t("widgets.hitl.announcement", { title: widgets[0]!.title })
          : t("widgets.hitl.announcementBatch", { count: widgets.length });
      setStatus(announcement);
      setCompanionState("thinking");
      if (ttsEnabledRef.current) {
        const speechId =
          widgets.length === 1
            ? `hitl:${widgets[0]!.decisionId}`
            : `hitl:batch:${widgets
                .map((widget) => widget.decisionId)
                .join("|")}`;
        void speakText(speechId, announcement, selectedTtsVoiceRef.current);
      }
    }

    function scheduleHitlAnnouncement(
      widget: DesktopAvatarHitlApprovalWidget,
    ): void {
      if (announcedHitlDecisionIdsRef.current.has(widget.decisionId)) {
        return;
      }
      announcedHitlDecisionIdsRef.current.add(widget.decisionId);
      pendingHitlAnnouncementsRef.current.set(widget.decisionId, widget);
      if (hitlAnnouncementTimeoutRef.current !== null) {
        return;
      }
      hitlAnnouncementTimeoutRef.current = window.setTimeout(
        flushHitlAnnouncements,
        HITL_ANNOUNCEMENT_BATCH_MS,
      );
    }

    function handleHitlEvent(event: HitlDecisionStreamEvent): void {
      setBackendConnectionState("connected");
      if (event.type === "snapshot") {
        setHitlWidgets(
          event.items
            .filter(
              (item) =>
                item.status === "pending" &&
                !locallySubmittedHitlDecisionIdsRef.current.has(item.decisionId),
            )
            .map((item) => toHitlWidget(item)),
        );
        return;
      }
      if (event.type !== "decision") {
        return;
      }
      if (
        event.kind === "resolved" ||
        event.kind === "execution_started" ||
        event.kind === "execution_finished" ||
        event.status !== "pending"
      ) {
        locallySubmittedHitlDecisionIdsRef.current.delete(event.decisionId);
        pendingHitlAnnouncementsRef.current.delete(event.decisionId);
        if (pendingHitlAnnouncementsRef.current.size === 0) {
          clearHitlAnnouncementTimeout();
        }
        setHitlWidgets((current) =>
          current.filter((widget) => widget.decisionId !== event.decisionId),
        );
        setStatus(t("widgets.hitl.updated"));
        return;
      }
      if (!event.item) {
        return;
      }
      if (locallySubmittedHitlDecisionIdsRef.current.has(event.decisionId)) {
        return;
      }
      const widget = toHitlWidget(event.item);
      setHitlWidgets((current) => upsertHitlWidget(current, widget));
      if (event.kind === "required") {
        scheduleHitlAnnouncement(widget);
      }
    }

    let active = true;
    let reconnectTimeoutId: number | null = null;
    let connecting = false;

    function clearReconnectTimeout(): void {
      if (reconnectTimeoutId === null) {
        return;
      }
      window.clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    function scheduleReconnect(): void {
      if (!active || reconnectTimeoutId !== null) {
        return;
      }
      reconnectTimeoutId = window.setTimeout(() => {
        reconnectTimeoutId = null;
        void connectHitlStream();
      }, HITL_STREAM_RECONNECT_MS);
    }

    async function connectHitlStream(): Promise<void> {
      if (!active || connecting) {
        return;
      }
      connecting = true;
      setBackendConnectionState((current) =>
        current === "connected" ? current : "connecting",
      );
      const previousConnection = hitlDecisionConnectionRef.current;
      hitlDecisionConnectionRef.current = null;
      try {
        await previousConnection?.close().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void frontendLog(
            "warn",
            `hitl stream cleanup before reconnect failed: ${message}`,
          );
        });
        const connection =
          await desktopAvatarApiClient.connectHitlDecisionStream({
            onEvent: handleHitlEvent,
            onDisconnect: (event) => {
              if (!active) {
                return;
              }
              const reason = event.reason ? `: ${event.reason}` : "";
              setBackendConnectionState("disconnected");
              void frontendLog(
                "warn",
                `hitl stream disconnected during ${event.phase}${reason}`,
              );
              scheduleReconnect();
            },
          });
        if (!active) {
          void connection.close();
          return;
        }
        hitlDecisionConnectionRef.current = connection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBackendConnectionState("unavailable");
        void frontendLog("warn", `hitl stream unavailable: ${message}`);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    }

    void connectHitlStream();

    return () => {
      active = false;
      clearHitlAnnouncementTimeout();
      pendingHitlAnnouncementsRef.current.clear();
      clearReconnectTimeout();
      const connection = hitlDecisionConnectionRef.current;
      hitlDecisionConnectionRef.current = null;
      void connection?.close();
    };
  }, []);
  const transcriptionProviderRef = useRef<TranscriptionProviderId>(
    transcriptionProvider,
  );
  const applyPeekModeRef = useRef<(mode: PeekMode) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    desktopAvatarStateRef.current = desktopAvatarState;
  }, [desktopAvatarState]);

  useEffect(() => {
    peekModeRef.current = peekMode;
  }, [peekMode]);

  useEffect(() => {
    transcriptionProviderRef.current = transcriptionProvider;
  }, [transcriptionProvider]);

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
          : Math.max(
              presetSizes.expanded.height,
              readStoredLastExpandedHeight(windowSize.height),
            );
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
          shouldAnimate,
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
    [animationEnabled, sizePreset, windowSize.height],
  );

  useEffect(() => {
    applyPeekModeRef.current = (mode: PeekMode) => applyPeekMode(mode);
  }, [applyPeekMode]);

  const clearRecordingMonitor = useCallback(() => {
    if (recordingMonitorIntervalRef.current !== null) {
      window.clearInterval(recordingMonitorIntervalRef.current);
      recordingMonitorIntervalRef.current = null;
    }
    recordingSilenceSinceMsRef.current = null;
    recordingStartedAtMsRef.current = null;
    recordingSpeechDetectedRef.current = false;
  }, []);

  const clearRecordingStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    recordingSourceNodeRef.current?.disconnect();
    recordingSourceNodeRef.current = null;
    recordingAnalyserNodeRef.current = null;

    const audioContext = recordingAudioContextRef.current;
    recordingAudioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {
        // Best-effort close.
      });
    }
  }, []);

  const stopActiveRecorder = useCallback(
    (reason: "manual" | "silence" | "limit" = "manual") => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        return;
      }
      recordingAutoStopReasonRef.current = reason;
      recorder.stop();
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
        } else if (isDesktopAvatarTerminalStatus(document.status)) {
          next.completedAtMs = current.completedAtMs ?? now;
        }

        return next;
      });
    },
    [patchLatencyByRequestKey],
  );

  const markLocalStreamEvent = useCallback(
    (event: StreamEnvelope) => {
      const now = Date.now();
      patchLatencyByRequestKey(event.requestId, (current) => {
        const next: LatencyTimeline = {
          ...current,
          firstEventAtMs: current.firstEventAtMs ?? now,
          status: event.kind,
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

          return {
            ...message,
            text: state.talkText || state.error || message.text,
            widget: state.widget,
            followUpQuestions: state.followUpQuestions,
            isStreaming: !state.isDone,
            requestStatus: state.status,
            avatarRequestId: activeRequest.avatarRequestId,
            clientRequestId: activeRequest.clientRequestId,
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
          });
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
      desktopAvatarConnectionRef.current =
        await desktopAvatarApiClient.connectStream({
          avatarRequestId,
          streamUrl,
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
    let unlistenStream: (() => void) | undefined;
    let unlistenTts: (() => void) | undefined;
    let unlistenTranscription: (() => void) | undefined;
    let unlistenTranscriptionProvider: (() => void) | undefined;
    let unlistenTrayPeekOpen: (() => void) | undefined;
    let unlistenTrayPeekCollapse: (() => void) | undefined;
    let unlistenTrayPeekPositionChanged: (() => void) | undefined;

    void (async () => {
      const bootstrap = await getBootstrapState();
      setAvatarManifest(bootstrap.avatarManifest);
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
          setTranscriptionProviderState(provider);
        })
        .catch(() => undefined);
      const presetSizes = getWindowSizesForPreset(sizePreset);
      const expandedHeight = Math.max(
        presetSizes.expanded.height,
        readStoredLastExpandedHeight(presetSizes.expanded.height),
      );
      setWindowSize({
        width: presetSizes.expanded.width,
        height: expandedHeight,
      });
      await setPeekMode(
        peekMode,
        presetSizes.expanded.width,
        expandedHeight,
        presetSizes.collapsed.width,
        presetSizes.collapsed.height,
        false,
        true,
      );
      setBootstrapReady(true);

      try {
        const voices = await listTtsVoices();
        const normalized = [
          ...new Set(voices.map((voice) => voice.trim()).filter(Boolean)),
        ];
        setTtsVoices(normalized);
        setSelectedTtsVoiceState((current) => {
          const nextVoice = resolvePreferredTtsVoice(current, normalized);
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
      } else if (!activeLocalRequestIdRef.current) {
        setCompanionState("idle");
        setStatus(null);
      }
    }).then((unlisten) => {
      unlistenTts = unlisten;
    });

    void onTranscriptionSessionEvent((event) => {
      if (event.type === "partial") {
        setStatus(
          t("status.transcribingPartial", {
            text: event.text.trim(),
          }),
        );
        setCompanionState("transcribing");
        return;
      }
      if (event.type === "error") {
        void frontendLog(
          "warn",
          `transcription provider ${event.provider} failed: ${event.message}`,
        );
      }
    }).then((unlisten) => {
      unlistenTranscription = unlisten;
    });

    void onTranscriptionProviderChanged((event) => {
      setTranscriptionProviderState(event.provider);
    }).then((unlisten) => {
      unlistenTranscriptionProvider = unlisten;
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
      unlistenTranscription?.();
      unlistenTranscriptionProvider?.();
      unlistenTrayPeekOpen?.();
      unlistenTrayPeekCollapse?.();
      unlistenTrayPeekPositionChanged?.();
      clearRecordingMonitor();
      clearRecordingStream();
      mediaRecorderRef.current = null;
      if (activeTranscriptionSessionIdRef.current) {
        void stopTranscriptionSession({
          sessionId: activeTranscriptionSessionIdRef.current,
        });
        activeTranscriptionSessionIdRef.current = null;
      }
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;
      void cleanupDesktopAvatarRuntime();
    };
  }, [
    clearRecordingMonitor,
    clearRecordingStream,
    cleanupDesktopAvatarRuntime,
  ]);

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
        ttsRequestedAtMs: current.ttsRequestedAtMs ?? requestedAtMs,
      }));
      void speakText(
        activeRequest.avatarRequestId,
        desktopAvatarState.talkText,
        selectedTtsVoice,
      );
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

  async function handleLocalStreamEvent(event: StreamEnvelope) {
    if (
      event.requestId !== activeLocalRequestIdRef.current &&
      !requestContextsRef.current.has(event.requestId)
    ) {
      return;
    }
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
        messages: buildLocalHistory(messagesRef.current),
      });
      return;
    }

    if (event.kind === "delta") {
      const payload = event.payload as StreamDeltaPayload;
      setMessages((current) =>
        current.map((message) =>
          message.id === event.requestId
            ? { ...message, text: payload.accumulated, isStreaming: true }
            : message,
        ),
      );
      setCompanionState("thinking");
      return;
    }

    if (event.kind === "final") {
      const payload = event.payload as StreamFinalPayload;
      const cleanedDisplay = sanitizeLocalAssistantText(payload.displayText);
      const cleanedSpeech = sanitizeLocalAssistantText(payload.speechText);
      const fallbackUsed = !cleanedDisplay && !cleanedSpeech;
      const displayText =
        cleanedDisplay || cleanedSpeech || t("status.localFallback");
      const speechText = cleanedSpeech || cleanedDisplay || displayText;
      if (fallbackUsed) {
        void frontendLog(
          "info",
          `local chat produced empty final payload; using fallback text for requestId=${event.requestId}`,
        );
      }
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
                followUpQuestions: [],
              }
            : message,
        ),
      );
      setStatus(null);
      if (ttsEnabled && !fallbackUsed) {
        patchLatencyByRequestKey(event.requestId, (current) => ({
          ...current,
          ttsRequestId: event.requestId,
          ttsRequestedAtMs: current.ttsRequestedAtMs ?? Date.now(),
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
                isStreaming: false,
              }
            : message,
        ),
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
            : message,
        ),
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
    const requestEpoch = conversationEpochRef.current;
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
              clientRequestId: null,
            }
          : message,
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
      route: "localChat",
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
      ttsRequestId: null,
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
        messages: buildLocalHistory(nextMessages),
      };
      await sendLocalChat(request);
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
        status: "error",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message,
      }));
      await handleLocalStreamEvent({
        requestId,
        source: "local",
        kind: "error",
        payload: { message },
      });
    }
  }

  async function submitDesktopAvatarPrompt(
    prompt: string,
    source: MessageSource,
    route: PromptRoute,
    clientRequestId?: string,
  ) {
    const requestEpoch = conversationEpochRef.current;
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
    activeLocalRequestIdRef.current = null;
    activeDesktopAvatarRequestRef.current = {
      assistantMessageId: assistantMessage.id,
      avatarRequestId: null,
      clientRequestId: requestId,
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
    }

    await stopSpeaking();
    await cleanupDesktopAvatarRuntime();

    try {
      const result = await desktopAvatarApiClient.createRequest(
        buildDesktopAvatarRequestInput(prompt, source, requestId),
      );
      if (requestEpoch !== conversationEpochRef.current) {
        return;
      }
      activeDesktopAvatarRequestRef.current = {
        ...(activeDesktopAvatarRequestRef.current ?? {
          assistantMessageId: assistantMessage.id,
          clientRequestId: requestId,
          prompt,
          source,
          route,
        }),
        avatarRequestId: result.avatarRequestId,
      };
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
      if (isUnsupportedNoMatchErrorMessage(message)) {
        void frontendLog(
          "info",
          `desktop-avatar fallback to local chat (unsupported/no-match): ${message}`,
        );
        await startLocalChatRequest({
          prompt,
          source,
          route,
          existingAssistantMessageId:
            activeDesktopAvatarRequestRef.current?.assistantMessageId ??
            assistantMessage.id,
          statusText: t("status.continuingLocally"),
        });
        return;
      }
      patchLatencyByRequestKey(requestId, (current) => ({
        ...current,
        status: "FAILED",
        failedAtMs: current.failedAtMs ?? Date.now(),
        lastError: message,
      }));
      desktopAvatarDispatch({ type: "requestFailed", message });
    }
  }

  async function submitPrompt(
    rawPrompt: string,
    source: MessageSource,
    retryClientRequestId?: string,
  ) {
    const prompt = rawPrompt.trim();
    if (!prompt) {
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

    if (route === "localChat") {
      await startLocalChatRequest({ prompt, source, route });
      return;
    }

    await submitDesktopAvatarPrompt(
      prompt,
      source,
      route,
      retryClientRequestId,
    );
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

  const applyOperatorRadarResponse = useCallback(
    (
      response: DesktopAvatarRadarResponse,
      options?: { showWidget?: boolean; showEmpty?: boolean },
    ) => {
      operatorRadarLastResponseRef.current = response;
      const visibleResponse = applyRadarSignalControls({
        response,
        controls: operatorRadarSignalControlsRef.current,
        nowMs: Date.now(),
      });
      setOperatorRadarSignalCount(visibleResponse.summary.totalCount);

      const shouldRenderWidget = Boolean(
        options?.showWidget || operatorRadarVisibleRef.current,
      );
      if (!shouldRenderWidget) {
        return;
      }
      if (visibleResponse.items.length === 0 && !options?.showEmpty) {
        setOperatorRadarWidget(null);
        return;
      }
      setOperatorRadarWidget(toOperatorRadarWidget(visibleResponse));
    },
    [],
  );

  const fetchOperatorRadar = useCallback(
    async (options?: { showWidget?: boolean; showEmpty?: boolean }) => {
      try {
        const response = await desktopAvatarApiClient.getRadar();
        applyOperatorRadarResponse(response, options);
      } catch (error) {
        const message = errorMessage(error, t("widgets.radar.errorMessage"));
        setOperatorRadarSignalCount(0);
        if (operatorRadarVisibleRef.current || options?.showWidget) {
          setOperatorRadarWidget({
            type: "error",
            title: t("widgets.radar.title"),
            message,
          });
        }
        void frontendLog("warn", `operator radar unavailable: ${message}`);
      }
    },
    [applyOperatorRadarResponse],
  );

  useEffect(() => {
    void fetchOperatorRadar();
    const intervalId = window.setInterval(() => {
      void fetchOperatorRadar();
    }, OPERATOR_RADAR_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [fetchOperatorRadar]);

  useEffect(() => {
    let active = true;
    let reconnectTimeoutId: number | null = null;
    let connecting = false;

    function clearReconnectTimeout(): void {
      if (reconnectTimeoutId === null) {
        return;
      }
      window.clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    function scheduleReconnect(): void {
      if (!active || reconnectTimeoutId !== null) {
        return;
      }
      reconnectTimeoutId = window.setTimeout(() => {
        reconnectTimeoutId = null;
        void connectRadarStream();
      }, OPERATOR_RADAR_STREAM_RECONNECT_MS);
    }

    function handleRadarStreamEvent(event: DesktopAvatarRadarStreamEvent): void {
      if (event.type === "snapshot" || event.type === "update") {
        applyOperatorRadarResponse(event.radar);
        return;
      }
      if (event.type === "error") {
        void frontendLog(
          "warn",
          `operator radar stream error: ${event.message}`,
        );
      }
    }

    async function connectRadarStream(): Promise<void> {
      if (!active || connecting) {
        return;
      }
      connecting = true;
      const previousConnection = operatorRadarConnectionRef.current;
      operatorRadarConnectionRef.current = null;
      try {
        await previousConnection?.close().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void frontendLog(
            "warn",
            `operator radar stream cleanup before reconnect failed: ${message}`,
          );
        });
        const connection = await desktopAvatarApiClient.connectRadarStream({
          onEvent: handleRadarStreamEvent,
          onDisconnect: (event) => {
            if (!active) {
              return;
            }
            const reason = event.reason ? `: ${event.reason}` : "";
            void frontendLog(
              "warn",
              `operator radar stream disconnected during ${event.phase}${reason}`,
            );
            scheduleReconnect();
          },
        });
        if (!active) {
          void connection.close();
          return;
        }
        operatorRadarConnectionRef.current = connection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void frontendLog("warn", `operator radar stream unavailable: ${message}`);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    }

    void connectRadarStream();

    return () => {
      active = false;
      clearReconnectTimeout();
      const connection = operatorRadarConnectionRef.current;
      operatorRadarConnectionRef.current = null;
      void connection?.close();
    };
  }, [applyOperatorRadarResponse]);

  async function setSizePreset(preset: SizePreset) {
    if (preset === sizePreset) {
      return;
    }

    const presetSizes = getWindowSizesForPreset(preset);
    setSizePresetState(preset);
    storeSizePreset(preset);

    const targetSize = {
      width: presetSizes.expanded.width,
      height: Math.max(windowSize.height, presetSizes.expanded.height),
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
        false,
      );
      return;
    }

    await setPeekMode(
      "peek",
      targetSize.width,
      targetSize.height,
      presetSizes.collapsed.width,
      presetSizes.collapsed.height,
      false,
    );
  }

  async function retryLastPrompt() {
    if (!lastSubmissionRef.current) {
      return;
    }

    const { prompt, source, route, clientRequestId } =
      lastSubmissionRef.current;
    const retryId = route === "localChat" ? undefined : clientRequestId;
    await submitPrompt(prompt, source, retryId);
  }

  async function clearConversation() {
    conversationEpochRef.current += 1;
    messagesRef.current = [];
    requestContextsRef.current.clear();
    lastSubmissionRef.current = null;
    activeLocalRequestIdRef.current = null;
    activeDesktopAvatarRequestRef.current = null;
    lastSpokenDesktopAvatarKeyRef.current = null;
    setMessages([]);
    setDraft("");
    setError(null);
    setStatus(null);
    setLatencyTimeline(null);
    setCompanionState("idle");
    desktopAvatarDispatch({ type: "reset" });
    await stopSpeaking();
    await cleanupDesktopAvatarRuntime();
  }

  async function startRecording() {
    if (isRecording) {
      return;
    }

    try {
      await stopSpeaking().catch(() => {
        // Recording should still start even if stopping TTS fails.
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const transcriptionSessionId = crypto.randomUUID();
      await startTranscriptionSession({
        sessionId: transcriptionSessionId,
        locale: navigator.language,
      });
      activeTranscriptionSessionIdRef.current = transcriptionSessionId;
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;
      recordingStartedAtMsRef.current = performance.now();
      recordingSilenceSinceMsRef.current = null;
      recordingSpeechDetectedRef.current = false;

      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      sourceNode.connect(analyserNode);
      recordingAudioContextRef.current = audioContext;
      recordingSourceNodeRef.current = sourceNode;
      recordingAnalyserNodeRef.current = analyserNode;

      const sampleBuffer = new Float32Array(analyserNode.fftSize);
      recordingMonitorIntervalRef.current = window.setInterval(() => {
        const activeRecorder = mediaRecorderRef.current;
        if (!activeRecorder || activeRecorder.state !== "recording") {
          return;
        }

        analyserNode.getFloatTimeDomainData(sampleBuffer);
        let sumSquares = 0;
        for (const sample of sampleBuffer) {
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / sampleBuffer.length);
        const now = performance.now();
        const startedAt = recordingStartedAtMsRef.current ?? now;
        const elapsedMs = now - startedAt;

        if (elapsedMs >= VOICE_MAX_RECORDING_MS) {
          setStatus(t("status.voiceAutoStoppedLimit"));
          stopActiveRecorder("limit");
          return;
        }

        if (rms >= VOICE_SPEECH_RMS_THRESHOLD) {
          recordingSpeechDetectedRef.current = true;
          recordingSilenceSinceMsRef.current = null;
          return;
        }

        if (!recordingSpeechDetectedRef.current) {
          if (elapsedMs >= VOICE_MAX_INITIAL_SILENCE_MS) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            stopActiveRecorder("silence");
          }
          return;
        }

        if (rms < VOICE_SILENCE_RMS_THRESHOLD) {
          if (recordingSilenceSinceMsRef.current === null) {
            recordingSilenceSinceMsRef.current = now;
          } else if (
            elapsedMs >= VOICE_MIN_AUTOSTOP_ELAPSED_MS &&
            now - recordingSilenceSinceMsRef.current >= VOICE_SILENCE_HOLD_MS
          ) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            stopActiveRecorder("silence");
          }
          return;
        }

        recordingSilenceSinceMsRef.current = null;
      }, VOICE_ACTIVITY_POLL_MS);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const autoStopReason = recordingAutoStopReasonRef.current;
        const startedAt = recordingStartedAtMsRef.current;
        const elapsedMs =
          startedAt === null ? 0 : Math.max(0, performance.now() - startedAt);
        clearRecordingMonitor();

        try {
          if (!chunksRef.current.some((chunk) => chunk.size > 0)) {
            if (autoStopReason === "silence") {
              setStatus(t("status.voiceAutoStoppedSilence"));
            } else if (autoStopReason === "limit") {
              setStatus(t("status.voiceAutoStoppedLimit"));
            } else {
              setStatus(null);
            }
            setCompanionState("idle");
            return;
          }

          const totalBytes = chunksRef.current.reduce(
            (sum, chunk) => sum + chunk.size,
            0,
          );
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          const speechDetected = recordingSpeechDetectedRef.current;
          void frontendLog(
            "info",
            `voice recording finished: mime=${blob.type || "audio/webm"} bytes=${totalBytes} elapsedMs=${Math.round(elapsedMs)} speechDetected=${speechDetected}`,
          );

          if (
            elapsedMs < VOICE_MIN_TRANSCRIPTION_MS ||
            totalBytes < VOICE_MIN_TRANSCRIPTION_BYTES
          ) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            setCompanionState("idle");
            return;
          }

          setCompanionState("transcribing");
          setStatus(t("status.transcribing"));
          const activeSessionId = activeTranscriptionSessionIdRef.current;
          if (!activeSessionId) {
            throw new Error("No active transcription session.");
          }
          const upload = await prepareTranscriptionUpload(
            blob,
            transcriptionProviderRef.current,
          );
          void frontendLog(
            "info",
            `voice transcription upload: provider=${transcriptionProviderRef.current} mime=${upload.mimeType} bytes=${upload.totalBytes} chunks=${upload.chunks.length}`,
          );
          for (const chunk of upload.chunks) {
            await appendTranscriptionAudio({
              sessionId: activeSessionId,
              audioBase64: chunk,
              mimeType: upload.mimeType,
            });
          }
          const transcript = await commitTranscriptionTurn({
            sessionId: activeSessionId,
          });
          await stopTranscriptionSession({ sessionId: activeSessionId }).catch(
            () => undefined,
          );
          activeTranscriptionSessionIdRef.current = null;
          const cleanedTranscript = transcript.trim();
          if (cleanedTranscript) {
            setStatus(
              t("status.voiceRecognized", {
                text: cleanedTranscript,
              }),
            );
            await waitMs(VOICE_TRANSCRIPT_PREVIEW_MS);
            await submitPrompt(cleanedTranscript, "voice");
          } else {
            setStatus(null);
            if (autoStopReason === "silence") {
              setStatus(t("status.voiceAutoStoppedSilence"));
            } else if (autoStopReason === "limit") {
              setStatus(t("status.voiceAutoStoppedLimit"));
            } else {
              setStatus(null);
            }
            setCompanionState("idle");
          }
        } catch (caughtError) {
          const fallbackMessage = t("status.voiceTranscriptionFailed");
          const detailedMessage = errorMessage(caughtError, fallbackMessage);
          const message = import.meta.env.DEV
            ? detailedMessage
            : fallbackMessage;
          void frontendLog(
            "error",
            `voice transcription failed: ${detailedMessage}`,
          );
          setError(message);
          setStatus(message);
          setCompanionState("error");
        } finally {
          setIsRecording(false);
          clearRecordingMonitor();
          clearRecordingStream();
          mediaRecorderRef.current = null;
          if (activeTranscriptionSessionIdRef.current) {
            await stopTranscriptionSession({
              sessionId: activeTranscriptionSessionIdRef.current,
            }).catch(() => undefined);
            activeTranscriptionSessionIdRef.current = null;
          }
          chunksRef.current = [];
          recordingAutoStopReasonRef.current = null;
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
      clearRecordingMonitor();
      clearRecordingStream();
      mediaRecorderRef.current = null;
      if (activeTranscriptionSessionIdRef.current) {
        await stopTranscriptionSession({
          sessionId: activeTranscriptionSessionIdRef.current,
        }).catch(() => undefined);
        activeTranscriptionSessionIdRef.current = null;
      }
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;
    }
  }

  async function stopRecording(
    reason: "manual" | "silence" | "limit" = "manual",
  ) {
    stopActiveRecorder(reason);
  }

  async function toggleRecording() {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  const findHitlWidget = useCallback(
    (decisionId: string) =>
      hitlWidgets.find((widget) => widget.decisionId === decisionId) ?? null,
    [hitlWidgets],
  );

  const markHitlActionSending = useCallback((decisionId: string) => {
    locallySubmittedHitlDecisionIdsRef.current.add(decisionId);
    setHitlWidgets((current) =>
      current.filter((item) => item.decisionId !== decisionId),
    );
    setStatus(t("widgets.hitl.sending"));
    setCompanionState("thinking");
  }, []);

  const restoreHitlAction = useCallback((widget: DesktopAvatarHitlApprovalWidget) => {
    locallySubmittedHitlDecisionIdsRef.current.delete(widget.decisionId);
    setHitlWidgets((current) => upsertHitlWidget(current, widget));
    setStatus(t("widgets.hitl.actionFailed"));
    setCompanionState("error");
  }, []);

  const markHitlActionSent = useCallback((decisionId: string) => {
    setStatus(t("widgets.hitl.sent"));
    setCompanionState("idle");
  }, []);

  const markHitlMoreInfoSent = useCallback(() => {
    setStatus(t("widgets.hitl.moreInfoSent"));
    setCompanionState("idle");
  }, []);

  const approveHitl = useCallback(
    async (decisionId: string, decisionReason?: string) => {
      const widget = findHitlWidget(decisionId);
      if (!widget?.proposalId) {
        return;
      }
      markHitlActionSending(decisionId);
      try {
        await desktopAvatarApiClient.approveHitlDecision({
          runId: widget.runId,
          proposalId: widget.proposalId,
          ...(decisionReason?.trim()
            ? { decisionReason: decisionReason.trim() }
            : {}),
        });
        markHitlActionSent(decisionId);
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlActionSending, markHitlActionSent, restoreHitlAction],
  );

  const rejectHitl = useCallback(
    async (decisionId: string, decisionReason: string) => {
      const widget = findHitlWidget(decisionId);
      const reason = decisionReason.trim();
      if (!widget?.proposalId || reason.length === 0) {
        return;
      }
      markHitlActionSending(decisionId);
      try {
        await desktopAvatarApiClient.rejectHitlDecision({
          runId: widget.runId,
          proposalId: widget.proposalId,
          decisionReason: reason,
        });
        markHitlActionSent(decisionId);
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlActionSending, markHitlActionSent, restoreHitlAction],
  );

  const requestMoreInfoForHitl = useCallback(
    async (decisionId: string, message: string) => {
      const widget = findHitlWidget(decisionId);
      const trimmed = message.trim();
      if (!widget || trimmed.length === 0) {
        return;
      }
      setStatus(t("widgets.hitl.sending"));
      setCompanionState("thinking");
      try {
        await desktopAvatarApiClient.requestMoreInfoForHitl({
          runId: widget.runId,
          message: trimmed,
        });
        markHitlMoreInfoSent();
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlMoreInfoSent, restoreHitlAction],
  );

  const openHitl = useCallback((decisionId: string) => {
    const url = `/Hitl?decisionId=${encodeURIComponent(decisionId)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  const openOperatorRadar = useCallback(() => {
    operatorRadarVisibleRef.current = true;
    void fetchOperatorRadar({ showWidget: true, showEmpty: true });
    if (peekMode !== "expanded") {
      void applyPeekMode("expanded");
    }
  }, [fetchOperatorRadar, peekMode, applyPeekMode]);

  const dismissOperatorRadar = useCallback(() => {
    operatorRadarVisibleRef.current = false;
    setOperatorRadarWidget(null);
  }, []);

  const renderCachedOperatorRadar = useCallback((options?: { showEmpty?: boolean }) => {
    const response = operatorRadarLastResponseRef.current;
    if (!response) {
      setOperatorRadarSignalCount(0);
      return;
    }
    const visibleResponse = applyRadarSignalControls({
      response,
      controls: operatorRadarSignalControlsRef.current,
      nowMs: Date.now(),
    });
    setOperatorRadarSignalCount(visibleResponse.summary.totalCount);
    if (!operatorRadarVisibleRef.current) {
      return;
    }
    if (visibleResponse.items.length === 0 && !options?.showEmpty) {
      setOperatorRadarWidget(null);
      return;
    }
    setOperatorRadarWidget(toOperatorRadarWidget(visibleResponse));
  }, []);

  const snoozeOperatorRadarSignal = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      controls.set(signalId, {
        ...current,
        followed: false,
        snoozedUntilMs: Date.now() + OPERATOR_RADAR_SNOOZE_MS,
      });
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );

  const toggleFollowOperatorRadarSignal = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      const nextFollowed = !current.followed;
      if (!nextFollowed && !current.completionOnly && !current.snoozedUntilMs) {
        controls.delete(signalId);
      } else {
        controls.set(signalId, {
          ...current,
          followed: nextFollowed,
          ...(nextFollowed
            ? { completionOnly: false, snoozedUntilMs: undefined }
            : {}),
        });
      }
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );

  const notifyOperatorRadarSignalOnCompletion = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      controls.set(signalId, {
        ...current,
        followed: false,
        completionOnly: true,
        snoozedUntilMs: undefined,
      });
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );

  const canSend = useMemo(() => draft.trim().length > 0, [draft]);
  const latencyDebug = useMemo(
    () => (latencyTimeline ? toLatencySnapshot(latencyTimeline) : null),
    [latencyTimeline],
  );

  return {
    avatarManifest,
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
    hitlWidgets,
    operatorRadarWidget,
    operatorRadarSignalCount,
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
    activeAnimation: activeDesktopAvatarRequestRef.current
      ? desktopAvatarState.animation
      : null,
    setDraft,
    setSizePreset,
    submitCurrentDraft: () => submitPrompt(draft, "text"),
    submitSuggestion: (value: string) => submitPrompt(value, "text"),
    clearConversation,
    approveHitl,
    rejectHitl,
    requestMoreInfoForHitl,
    openHitl,
    openOperatorRadar,
    dismissOperatorRadar,
    snoozeOperatorRadarSignal,
    toggleFollowOperatorRadarSignal,
    notifyOperatorRadarSignalOnCompletion,
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
        await stopSpeaking();
      }
      setTtsEnabled((current) => {
        const next = !current;
        storeTtsEnabled(next);
        return next;
      });
    },
    resizeWindow: async (
      width: number,
      height: number,
      anchor?: WindowResizeAnchor,
    ) => {
      await resizeWindow(width, height, anchor);
      setWindowSize({ width, height });
      storeLastExpandedSize(width, height);
    },
    startWindowDrag: () => startWindowDragForMode(peekModeRef.current),
  };
}
