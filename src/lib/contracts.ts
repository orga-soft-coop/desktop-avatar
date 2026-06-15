export type PromptRoute = "localChat" | "backendBusiness" | "backendReview";
export type TranscriptionProviderId =
  | "openai-realtime"
  | "openai-file-fallback";
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
export type BackendConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "unavailable";
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
export type PeekMode = "peek" | "expanded";
export type PeekPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
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

export interface DesktopAvatarHitlContextEntry {
  label: string;
  value: string;
  type: "text" | "badge" | "metric";
  severity?: "info" | "warning" | "critical" | "success";
}

export interface DesktopAvatarHitlContextSection {
  id: string;
  title: string;
  icon: string;
  entries: DesktopAvatarHitlContextEntry[];
}

export interface DesktopAvatarHitlApprovalWidget {
  type: "hitlApproval";
  decisionId: string;
  runId: string;
  proposalId?: string;
  actionId?: string;
  title: string;
  description: string;
  agentName: string;
  mode: DesktopAvatarMode;
  status: "pending" | "approved" | "declined" | "executing" | "completed" | "failed";
  priority: "low" | "medium" | "high" | "critical";
  contextSections: DesktopAvatarHitlContextSection[];
}

export type DesktopAvatarRadarSignalKind =
  | "hitlApproval"
  | "waitingDecision"
  | "runtimeRunning"
  | "runtimeCompleted"
  | "runtimeFailure";
export type DesktopAvatarRadarSeverity = "info" | "warning" | "high" | "critical";
export type DesktopAvatarRadarStatus =
  | "needsApproval"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "blocked";
export type DesktopAvatarRadarAudienceScope =
  | "personal"
  | "team"
  | "department"
  | "management";
export type StudioAgentRole = "DOMAIN" | "OPERATIONS_MANAGER";

export interface DesktopAvatarRadarAudience {
  scope: DesktopAvatarRadarAudienceScope;
  label?: string;
  note?: string;
}

export type DesktopAvatarRadarSourceKind =
  | "hitl"
  | "runtimeFlow"
  | "desktopAvatarRequest";

export interface DesktopAvatarRadarSource {
  kind: DesktopAvatarRadarSourceKind;
  label: string;
  requestId?: string;
  runId?: string;
  proposalId?: string;
  decisionId?: string;
  actionId?: string;
  status?: string;
}

export interface DesktopAvatarRadarTimelineItem {
  id: string;
  title: string;
  timestamp: string;
  description?: string;
  status?: string;
}

export interface DesktopAvatarRadarSignalClientState {
  followed?: boolean;
  completionOnly?: boolean;
  snoozedUntil?: string;
}

export interface DesktopAvatarRadarSignal {
  signalId: string;
  kind: DesktopAvatarRadarSignalKind;
  severity: DesktopAvatarRadarSeverity;
  status: DesktopAvatarRadarStatus;
  title: string;
  description: string;
  studioAgentId: string;
  agentName: string;
  agentRole: StudioAgentRole;
  agentAvatarId?: string | number;
  runId?: string;
  proposalId?: string;
  decisionId?: string;
  actionId?: string;
  updatedAt: string;
  audience: DesktopAvatarRadarAudience;
  source?: DesktopAvatarRadarSource;
  why?: string;
  timeline?: DesktopAvatarRadarTimelineItem[];
  clientState?: DesktopAvatarRadarSignalClientState;
}

export interface DesktopAvatarRadarSummary {
  totalCount: number;
  criticalCount: number;
  highCount: number;
  needsApprovalCount: number;
  runningCount: number;
  failedCount: number;
  topSignalId?: string;
}

export interface DesktopAvatarRadarResponse {
  generatedAt: string;
  summary: DesktopAvatarRadarSummary;
  items: DesktopAvatarRadarSignal[];
}

export type DesktopAvatarRadarStreamReason =
  | "hitl"
  | "runtimeFlow"
  | "desktopAvatarRequest"
  | "refresh";

export interface DesktopAvatarRadarStreamReadyEvent {
  type: "ready";
  status: "connected";
  retryMs?: number;
  emittedAt: string;
}

export interface DesktopAvatarRadarStreamSnapshotEvent {
  type: "snapshot";
  eventId: string;
  radar: DesktopAvatarRadarResponse;
  emittedAt: string;
}

export interface DesktopAvatarRadarStreamUpdateEvent {
  type: "update";
  eventId: string;
  reasons: DesktopAvatarRadarStreamReason[];
  radar: DesktopAvatarRadarResponse;
  emittedAt: string;
}

export interface DesktopAvatarRadarStreamErrorEvent {
  type: "error";
  eventId: string;
  message: string;
  emittedAt: string;
}

export type DesktopAvatarRadarStreamEvent =
  | DesktopAvatarRadarStreamReadyEvent
  | DesktopAvatarRadarStreamSnapshotEvent
  | DesktopAvatarRadarStreamUpdateEvent
  | DesktopAvatarRadarStreamErrorEvent;

export interface DesktopAvatarOperatorRadarWidget {
  type: "operatorRadar";
  title: string;
  generatedAt: string;
  summary: DesktopAvatarRadarSummary;
  items: DesktopAvatarRadarSignal[];
}

export interface HitlDecisionQueueItem {
  decisionId: string;
  runId: string;
  proposalId?: string;
  actionId?: string;
  title: string;
  description: string;
  agent: {
    agentId: string;
    agentName: string;
    agentAvatarId: number;
  };
  timestamp: string;
  mode: DesktopAvatarMode;
  status: DesktopAvatarHitlApprovalWidget["status"];
  priority: DesktopAvatarHitlApprovalWidget["priority"];
  contextSections: DesktopAvatarHitlContextSection[];
  payload: Record<string, unknown>;
}

export type DesktopAvatarWidgetPayload =
  | DesktopAvatarTableWidget
  | DesktopAvatarKeyValueWidget
  | DesktopAvatarTextWidget
  | DesktopAvatarAreaChartWidget
  | DesktopAvatarClarificationWidget
  | DesktopAvatarHitlApprovalWidget
  | DesktopAvatarOperatorRadarWidget
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

export interface HitlDecisionStreamReadyEvent {
  type: "ready";
  emittedAt: string;
}

export interface HitlDecisionStreamSnapshotEvent {
  type: "snapshot";
  items: HitlDecisionQueueItem[];
  emittedAt: string;
}

export interface HitlDecisionStreamDecisionEvent {
  type: "decision";
  kind:
    | "required"
    | "updated"
    | "resolved"
    | "execution_started"
    | "execution_finished";
  decisionId: string;
  runId: string;
  proposalId?: string;
  status: DesktopAvatarHitlApprovalWidget["status"];
  item?: HitlDecisionQueueItem;
  emittedAt: string;
}

export type HitlDecisionStreamEvent =
  | HitlDecisionStreamReadyEvent
  | HitlDecisionStreamSnapshotEvent
  | HitlDecisionStreamDecisionEvent;

export interface HitlDecisionStreamLifecycleEvent {
  phase: "closed" | "aborted" | "error";
  reason?: string | null;
}

export interface DesktopAvatarRadarStreamLifecycleEvent {
  phase: "closed" | "aborted" | "error";
  reason?: string | null;
}

export interface HitlDecisionInput {
  runId: string;
  proposalId: string;
  decisionReason?: string;
}

export interface HitlRequestMoreInfoInput {
  runId: string;
  message: string;
}

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
  transcriptionProvider: TranscriptionProviderId;
  transcriptionProviders: TranscriptionProviderId[];
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
  locale?: string;
}

export interface TranscriptionSessionStartRequest {
  sessionId: string;
  locale?: string;
}

export interface TranscriptionSessionStartResult {
  sessionId: string;
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionAppendAudioRequest {
  sessionId: string;
  audioBase64: string;
  mimeType: string;
}

export interface TranscriptionSessionCommitTurnRequest {
  sessionId: string;
}

export interface TranscriptionSessionStopRequest {
  sessionId: string;
}

export interface TranscriptionProviderChangedEvent {
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionReadyEvent {
  type: "session_ready";
  sessionId: string;
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionPartialEvent {
  type: "partial";
  sessionId: string;
  text: string;
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionFinalEvent {
  type: "final";
  sessionId: string;
  text: string;
  provider: TranscriptionProviderId;
  fallbackUsed: boolean;
}

export interface TranscriptionSessionSpeechStartedEvent {
  type: "speech_started";
  sessionId: string;
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionSpeechStoppedEvent {
  type: "speech_stopped";
  sessionId: string;
  provider: TranscriptionProviderId;
}

export interface TranscriptionSessionErrorEvent {
  type: "error";
  sessionId: string;
  provider: TranscriptionProviderId;
  message: string;
}

export type TranscriptionSessionEvent =
  | TranscriptionSessionReadyEvent
  | TranscriptionSessionPartialEvent
  | TranscriptionSessionFinalEvent
  | TranscriptionSessionSpeechStartedEvent
  | TranscriptionSessionSpeechStoppedEvent
  | TranscriptionSessionErrorEvent;

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
