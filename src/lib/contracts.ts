export type PromptRoute = "localChat" | "backendBusiness" | "backendReview";
export type CompanionState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";
export type MessageRole = "user" | "assistant" | "system";
export type MessageSource = "text" | "voice" | "system";
export type DesktopAvatarMode = "SIMULATION" | "EXECUTION";
export type DesktopAvatarModality = "chat" | "voice";
export type DesktopAvatarResponseMode = "talk" | "widget";
export type DesktopAvatarRequestStatus =
  | "RECEIVED"
  | "ROUTING"
  | "THINKING"
  | "FETCHING_DATA"
  | "FORMATTING_RESPONSE"
  | "TALK_READY"
  | "WIDGET_READY"
  | "COMPLETED"
  | "NEEDS_CLARIFICATION"
  | "FAILED";
export type DesktopAvatarWidgetScalar = string | number | boolean | null;
export type DesktopAvatarAnimationKey = "idle" | "attention" | "thinking" | "talking";
export type PackedAvatarAnimationState =
  | "idle"
  | "walking"
  | "working"
  | "communicating"
  | "coffee-break"
  | "at-phone"
  | "teleport-out"
  | "teleport-in"
  | "talking"
  | "attention"
  | "thinking";

export interface DesktopAvatarTableWidget {
  type: "table";
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, DesktopAvatarWidgetScalar>>;
}

export interface DesktopAvatarKeyValueWidget {
  type: "keyValue";
  title: string;
  items: Array<{
    key: string;
    label: string;
    value: DesktopAvatarWidgetScalar;
  }>;
}

export interface DesktopAvatarTextWidget {
  type: "text";
  title: string;
  text: string;
}

export interface DesktopAvatarAreaChartWidget {
  type: "areaChart";
  title: string;
  xKey: string;
  series: Array<{
    key: string;
    label: string;
    color?: string;
  }>;
  rows: Array<Record<string, string | number | null>>;
  summary?: string;
}

export interface DesktopAvatarClarificationWidget {
  type: "clarification";
  title: string;
  question: string;
  suggestions: string[];
}

export interface DesktopAvatarErrorWidget {
  type: "error";
  title: string;
  message: string;
}

export type DesktopAvatarWidgetPayload =
  | DesktopAvatarTableWidget
  | DesktopAvatarKeyValueWidget
  | DesktopAvatarTextWidget
  | DesktopAvatarAreaChartWidget
  | DesktopAvatarClarificationWidget
  | DesktopAvatarErrorWidget;

export interface DesktopAvatarTalkPayload {
  text: string;
}

export interface DesktopAvatarResponse {
  talk: DesktopAvatarTalkPayload;
  widget?: DesktopAvatarWidgetPayload | null;
  followUpQuestions: string[];
}

export interface CreateDesktopAvatarRequestInput {
  clientRequestId: string;
  requestedBy?: string;
  mode?: DesktopAvatarMode;
  modality?: DesktopAvatarModality;
  locale?: string;
  timezone?: string;
  utterance: string;
  responseModes?: DesktopAvatarResponseMode[];
  targetStudioAgentId?: string;
  iwsQueryRequest?: Record<string, unknown>;
  autoStart?: boolean;
}

export interface CreateDesktopAvatarRequestResult {
  accepted: boolean;
  avatarRequestId: string;
  status: DesktopAvatarRequestStatus;
  streamUrl: string;
  pollUrl: string;
  idempotent: boolean;
}

export interface DesktopAvatarRequestDocument {
  avatarRequestId: string;
  clientRequestId: string;
  requestedBy?: string;
  mode?: DesktopAvatarMode;
  modality?: DesktopAvatarModality;
  locale?: string;
  timezone?: string;
  utterance?: string;
  responseModes?: DesktopAvatarResponseMode[];
  status: DesktopAvatarRequestStatus;
  response?: DesktopAvatarResponse | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface DesktopAvatarStreamReadyEvent {
  type: "ready";
  avatarRequestId: string;
  emittedAt: string;
}

export interface DesktopAvatarStreamStatusEvent {
  type: "status";
  avatarRequestId: string;
  status: DesktopAvatarRequestStatus;
  message?: string;
  emittedAt: string;
}

export interface DesktopAvatarStreamTalkEvent {
  type: "talk";
  avatarRequestId: string;
  talk: DesktopAvatarTalkPayload;
  emittedAt: string;
}

export interface DesktopAvatarStreamWidgetEvent {
  type: "widget";
  avatarRequestId: string;
  widget: DesktopAvatarWidgetPayload;
  emittedAt: string;
}

export interface DesktopAvatarStreamDoneEvent {
  type: "done";
  avatarRequestId: string;
  status: DesktopAvatarRequestStatus;
  emittedAt: string;
}

export interface DesktopAvatarStreamErrorEvent {
  type: "error";
  avatarRequestId: string;
  error: string;
  emittedAt: string;
}

export type DesktopAvatarStreamEvent =
  | DesktopAvatarStreamReadyEvent
  | DesktopAvatarStreamStatusEvent
  | DesktopAvatarStreamTalkEvent
  | DesktopAvatarStreamWidgetEvent
  | DesktopAvatarStreamDoneEvent
  | DesktopAvatarStreamErrorEvent;

export interface DesktopAvatarStreamLifecycleEvent {
  avatarRequestId: string;
  phase: "closed" | "aborted" | "error";
  reason?: string | null;
}

export interface AvatarManifest {
  displayName?: string | null;
  license?: string | null;
  thumbnailUrl?: string | null;
  modelUrl?: string | null;
  animationMapping?: Partial<Record<PackedAvatarAnimationState, string>>;
  vrmUrl?: string | null;
  idleAnimationUrls?: string[];
  attentionAnimationUrl?: string | null;
  thinkingAnimationUrl?: string | null;
  talkingAnimationUrl?: string | null;
}

export interface BootstrapState {
  avatarManifest: AvatarManifest | null;
  collapsedSize: { width: number; height: number };
  expandedSize: { width: number; height: number };
  ttsEnabled: boolean;
}

export interface LocalChatMessageInput {
  role: Exclude<MessageRole, "system"> | "system";
  content: string;
}

export interface LocalChatRequest {
  requestId: string;
  prompt: string;
  messages: LocalChatMessageInput[];
}

export interface SpeechTranscriptionRequest {
  audioBase64: string;
  mimeType: string;
}

export interface StreamEnvelope<T = unknown> {
  requestId: string;
  source: "local" | "business";
  kind:
    | "acknowledged"
    | "researching"
    | "tool_progress"
    | "handoff_local"
    | "delta"
    | "final"
    | "error";
  payload: T;
}

export interface StreamTextPayload {
  text?: string | null;
}

export interface StreamDeltaPayload {
  delta: string;
  accumulated: string;
}

export interface StreamFinalPayload {
  type: "generic_text" | "error";
  speechText: string;
  displayText: string;
}

export interface StreamErrorPayload {
  message: string;
  retryHint?: string | null;
}

export interface TtsStateEvent {
  requestId: string;
  speaking: boolean;
  provider?: string;
  fallback?: boolean;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  source: MessageSource;
  widget?: DesktopAvatarWidgetPayload | null;
  followUpQuestions?: string[];
  isStreaming?: boolean;
  requestStatus?: DesktopAvatarRequestStatus | null;
  clientRequestId?: string | null;
  avatarRequestId?: string | null;
}

export interface DevToolsLatencySnapshot {
  requestKey: string;
  requestKind: "desktop-avatar" | "local-chat";
  route: PromptRoute;
  source: MessageSource;
  status: string | null;
  startedAt: string;
  usedPolling: boolean;
  createAcceptedMs: number | null;
  streamConnectedMs: number | null;
  firstEventMs: number | null;
  firstResponseMs: number | null;
  talkMs: number | null;
  widgetMs: number | null;
  pollFallbackMs: number | null;
  completedMs: number | null;
  failedMs: number | null;
  ttsRequestedMs: number | null;
  ttsStartedMs: number | null;
  ttsSpeakDurationMs: number | null;
  talkToTtsStartMs: number | null;
  ttsProvider: string | null;
  ttsFallbackUsed: boolean | null;
  lastError: string | null;
  clientRequestId: string | null;
  avatarRequestId: string | null;
  ttsRequestId: string | null;
}
