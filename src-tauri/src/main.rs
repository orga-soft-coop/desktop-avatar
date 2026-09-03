mod agent_studio;

use agent_studio::{
    AgentStudioApiClient, AgentStudioApiError, AgentStudioSessionBroker, AuthBranchSummary,
    AuthCompanySummary, AuthPreauthenticateResult, DesktopAvatarTenantSession,
};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    fs::OpenOptions,
    hash::{DefaultHasher, Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::{AUTHORIZATION, CONTENT_TYPE},
    multipart::{Form, Part},
    Client, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime,
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, RunEvent, Size, State,
    WebviewWindow, WindowEvent,
};
use tokio::{
    process::Command,
    sync::{oneshot, Mutex},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, protocol::Message as WsMessage},
};

const DESKTOP_AVATAR_STREAM_EVENT: &str = "desktop-avatar-stream-event";
const DESKTOP_AVATAR_STREAM_LIFECYCLE_EVENT: &str = "desktop-avatar-stream-lifecycle";
const DESKTOP_AVATAR_RADAR_STREAM_EVENT: &str = "desktop-avatar-radar-stream-event";
const DESKTOP_AVATAR_RADAR_STREAM_LIFECYCLE_EVENT: &str = "desktop-avatar-radar-stream-lifecycle";
const HITL_DECISION_STREAM_EVENT: &str = "hitl-decision-stream-event";
const HITL_DECISION_STREAM_LIFECYCLE_EVENT: &str = "hitl-decision-stream-lifecycle";
const TTS_STATE_EVENT: &str = "tts-state";
const TRANSCRIPTION_STREAM_EVENT: &str = "transcription-stream-event";
const TRANSCRIPTION_PROVIDER_CHANGED_EVENT: &str = "transcription-provider-changed";
const MAIN_TRAY_ID: &str = "desktop-avatar-main-tray";
const DEFAULT_PEEK_WIDTH: f64 = 235.0;
const DEFAULT_PEEK_HEIGHT: f64 = 235.0;
const MAX_PEEK_WIDTH: f64 = 360.0;
const MAX_PEEK_HEIGHT: f64 = 360.0;
const EXPANDED_WIDTH: f64 = 720.0;
const EXPANDED_HEIGHT: f64 = 700.0;
const PEEK_WINDOW_MARGIN: f64 = 48.0;
const EXPANDED_WINDOW_MARGIN: f64 = 24.0;
const TRANSITION_STEPS: u32 = 14;
const TRANSITION_DURATION_MS: u64 = 240;
const TRANSITION_STAGE_DURATION_MS: u64 = 150;
const TRANSCRIPTION_MAX_AUDIO_BYTES: usize = 24 * 1024 * 1024;
const TRANSCRIPTION_CHUNK_BYTES: usize = 12 * 1024;
const TRANSCRIPTION_READ_TIMEOUT_SECS: u64 = 20;

#[derive(Clone)]
struct AppState {
    client: Client,
    config: Arc<AppConfig>,
    agent_studio: Result<Arc<AgentStudioSessionBroker>, AgentStudioApiError>,
    desktop_avatar_streams: Arc<Mutex<HashMap<String, OwnedStreamHandle>>>,
    desktop_avatar_radar_stream: Arc<Mutex<Option<OwnedStreamHandle>>>,
    hitl_decision_stream: Arc<Mutex<Option<OwnedStreamHandle>>>,
    last_tts_text_by_request: Arc<Mutex<HashMap<String, u64>>>,
    tts_generation: Arc<AtomicU64>,
    tts_processes: Arc<Mutex<HashMap<String, TtsProcessHandle>>>,
    shutdown_started: Arc<AtomicBool>,
    peek_position: Arc<Mutex<PeekPosition>>,
    current_window_mode: Arc<Mutex<WindowMode>>,
    last_peek_rect: Arc<Mutex<Option<WindowRect>>>,
    last_expanded_rect: Arc<Mutex<Option<WindowRect>>>,
    suppress_window_tracking: Arc<Mutex<bool>>,
    drag_tracking_mode: Arc<Mutex<Option<WindowMode>>>,
    drag_tracking_revision: Arc<Mutex<u64>>,
    peek_size: Arc<Mutex<WindowSize>>,
    transcription_provider: Arc<Mutex<TranscriptionProviderId>>,
    transcription_sessions: Arc<Mutex<HashMap<String, TranscriptionSession>>>,
}

struct TtsProcessHandle {
    cancel: oneshot::Sender<()>,
    stopped: oneshot::Receiver<()>,
}

struct OwnedStreamHandle {
    owner_id: String,
    context_id: String,
    handle: async_runtime::JoinHandle<()>,
}

fn take_stream_if_owner(
    slot: &mut Option<OwnedStreamHandle>,
    owner_id: &str,
) -> Option<OwnedStreamHandle> {
    if slot
        .as_ref()
        .is_some_and(|owned| owned.owner_id == owner_id)
    {
        slot.take()
    } else {
        None
    }
}

fn remove_stream_if_owner(
    streams: &mut HashMap<String, OwnedStreamHandle>,
    key: &str,
    owner_id: &str,
) -> Option<OwnedStreamHandle> {
    if streams
        .get(key)
        .is_some_and(|owned| owned.owner_id == owner_id)
    {
        streams.remove(key)
    } else {
        None
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum PeekPosition {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Default for PeekPosition {
    fn default() -> Self {
        Self::TopRight
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum WindowMode {
    Peek,
    Expanded,
}

impl Default for WindowMode {
    fn default() -> Self {
        Self::Peek
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum TranscriptionProviderId {
    OpenAiRealtime,
    OpenAiFileFallback,
}

impl TranscriptionProviderId {
    fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai-realtime" => Ok(Self::OpenAiRealtime),
            "openai-file-fallback" => Ok(Self::OpenAiFileFallback),
            _ => Err(format!(
                "Unsupported transcription provider: {}",
                value.trim()
            )),
        }
    }
}

fn transcription_provider_label(provider: TranscriptionProviderId) -> &'static str {
    match provider {
        TranscriptionProviderId::OpenAiRealtime => "openai-realtime",
        TranscriptionProviderId::OpenAiFileFallback => "openai-file-fallback",
    }
}

#[derive(Debug, Clone)]
struct TranscriptionSession {
    session_id: String,
    context_id: String,
    local_epoch: u64,
    provider: TranscriptionProviderId,
    locale: Option<String>,
    mime_type: String,
    audio_bytes: Vec<u8>,
}

#[derive(Clone)]
struct TenantExecutionGuard {
    broker: Arc<AgentStudioSessionBroker>,
    session: DesktopAvatarTenantSession,
}

impl TenantExecutionGuard {
    async fn ensure_current(&self) -> Result<(), String> {
        ensure_stream_current(&self.broker, &self.session).await
    }
}

#[derive(Clone, Debug)]
struct AppConfig {
    comm_officer_base_url: Option<String>,
    comm_officer_csrf_cookie_name: Option<String>,
    openai_api_key: Option<String>,
    openai_stt_model: String,
    transcription_provider_default: TranscriptionProviderId,
    transcription_provider_fallback: Option<TranscriptionProviderId>,
    openai_realtime_stt_model: String,
    tts_provider: TtsProviderMode,
    openai_tts_enabled: bool,
    openai_tts_model: String,
    openai_tts_default_voice: String,
    openai_tts_voices: Vec<String>,
    local_tts_url: Option<String>,
    local_tts_api_key: Option<String>,
    local_tts_model: String,
    local_tts_default_voice: String,
    local_tts_voices: Vec<String>,
    local_tts_request_template: Value,
    local_tts_response_base64_path: Option<String>,
    local_tts_headers: HashMap<String, String>,
    avatar_asset_manifest: Option<PathBuf>,
    log_file_path: PathBuf,
    window_state_path: PathBuf,
    enable_tts: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AvatarManifest {
    display_name: Option<String>,
    license: Option<String>,
    thumbnail_url: Option<String>,
    #[serde(default)]
    model_url: Option<String>,
    #[serde(default)]
    animation_mapping: Option<HashMap<String, String>>,
    #[serde(default)]
    vrm_url: Option<String>,
    #[serde(default, alias = "idleVrmaUrls")]
    idle_animation_urls: Vec<String>,
    #[serde(default, alias = "attentionVrmaUrl")]
    attention_animation_url: Option<String>,
    #[serde(default, alias = "thinkingVrmaUrl")]
    thinking_animation_url: Option<String>,
    #[serde(default, alias = "talkingVrmaUrl")]
    talking_animation_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
    avatar_manifest: Option<AvatarManifest>,
    collapsed_size: WindowSize,
    expanded_size: WindowSize,
    tts_enabled: bool,
    transcription_provider: String,
    transcription_providers: Vec<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowSize {
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    #[serde(default)]
    peek_position: PeekPosition,
    #[serde(default = "default_peek_size")]
    peek_size: WindowSize,
    #[serde(default)]
    last_peek_rect: Option<WindowRect>,
    #[serde(default)]
    last_expanded_rect: Option<WindowRect>,
}

impl Default for PersistedWindowState {
    fn default() -> Self {
        Self {
            peek_position: PeekPosition::default(),
            peek_size: default_peek_size(),
            last_peek_rect: None,
            last_expanded_rect: None,
        }
    }
}

fn default_peek_size() -> WindowSize {
    WindowSize {
        width: DEFAULT_PEEK_WIDTH,
        height: DEFAULT_PEEK_HEIGHT,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetPayload {
    mime_type: String,
    base64: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDesktopAvatarRequestInput {
    client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modality: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timezone: Option<String>,
    utterance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_modes: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_studio_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    iws_query_request: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auto_start: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum DesktopAvatarRequestStatus {
    Received,
    Routing,
    Thinking,
    FetchingData,
    FormattingResponse,
    TalkReady,
    WidgetReady,
    Completed,
    NeedsClarification,
    Failed,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum DesktopAvatarMode {
    Simulation,
    Execution,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
enum DesktopAvatarModality {
    Chat,
    Voice,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "lowercase")]
enum DesktopAvatarResponseMode {
    Talk,
    Widget,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDesktopAvatarRequestResult {
    accepted: bool,
    avatar_request_id: String,
    status: DesktopAvatarRequestStatus,
    stream_url: String,
    poll_url: String,
    idempotent: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DesktopAvatarRequestDocument {
    #[serde(alias = "id")]
    avatar_request_id: String,
    client_request_id: String,
    requested_by: String,
    mode: DesktopAvatarMode,
    modality: DesktopAvatarModality,
    locale: Option<String>,
    timezone: Option<String>,
    utterance: String,
    response_modes: Vec<DesktopAvatarResponseMode>,
    status: DesktopAvatarRequestStatus,
    status_message: Option<String>,
    target_studio_agent_id: Option<String>,
    runtime_session_id: Option<String>,
    run_id: Option<String>,
    iws_query_request: Option<Value>,
    response: Option<Value>,
    error: Option<String>,
    created_at: String,
    updated_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HitlDecisionInput {
    run_id: String,
    proposal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HitlRequestMoreInfoInput {
    run_id: String,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthCredentialsInput {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthCompleteInput {
    company_id: String,
    branch_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarStreamLifecycleEvent {
    context_id: String,
    avatar_request_id: String,
    phase: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HitlDecisionStreamLifecycleEvent {
    context_id: String,
    phase: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarRadarStreamLifecycleEvent {
    context_id: String,
    phase: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SpeechTranscriptionRequest {
    audio_base64: String,
    mime_type: String,
    locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionSessionStartRequest {
    session_id: String,
    locale: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionSessionAppendAudioRequest {
    session_id: String,
    audio_base64: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionSessionCommitTurnRequest {
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TranscriptionSessionStopRequest {
    session_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptionSessionStartResult {
    session_id: String,
    provider: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TranscriptionStreamEvent {
    SessionReady {
        session_id: String,
        provider: String,
    },
    SpeechStarted {
        session_id: String,
        provider: String,
    },
    SpeechStopped {
        session_id: String,
        provider: String,
    },
    Partial {
        session_id: String,
        text: String,
        provider: String,
    },
    Final {
        session_id: String,
        text: String,
        provider: String,
        fallback_used: bool,
    },
    Error {
        session_id: String,
        provider: String,
        message: String,
    },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TranscriptionProviderChangedEvent {
    provider: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TtsStateEvent {
    context_id: String,
    request_id: String,
    speaking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<bool>,
}

#[derive(Default, Debug, Clone)]
struct SseFrame {
    event: String,
    data_lines: Vec<String>,
}

impl SseFrame {
    fn new() -> Self {
        Self {
            event: "message".to_string(),
            data_lines: Vec::new(),
        }
    }

    fn data(&self) -> String {
        self.data_lines.join("\n")
    }
}

#[derive(Default, Debug)]
struct SseParser {
    current: SseFrame,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TtsProviderMode {
    Auto,
    Local,
    FishAudio,
    OpenAI,
    System,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TtsHttpRequestFormat {
    OpenAiCompat,
    FishAudio,
}

impl SseParser {
    fn push_line(&mut self, line: &str) -> Option<SseFrame> {
        if line.is_empty() {
            return self.flush();
        }

        if line.starts_with(':') {
            return None;
        }

        let mut parts = line.splitn(2, ':');
        let field = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default().trim_start();

        match field {
            "event" => self.current.event = value.to_string(),
            "data" => self.current.data_lines.push(value.to_string()),
            _ => {}
        }

        None
    }

    fn finish(&mut self) -> Option<SseFrame> {
        self.flush()
    }

    fn flush(&mut self) -> Option<SseFrame> {
        if self.current.data_lines.is_empty() {
            self.current = SseFrame::new();
            return None;
        }

        let frame = self.current.clone();
        self.current = SseFrame::new();
        Some(frame)
    }
}

impl TtsProviderMode {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "local" => Self::Local,
            "fish" | "fishaudio" | "fish-audio" => Self::FishAudio,
            "openai" => Self::OpenAI,
            "system" | "say" => Self::System,
            _ => Self::Auto,
        }
    }
}

fn tts_provider_name(provider: TtsProviderMode) -> &'static str {
    match provider {
        TtsProviderMode::Local => "local",
        TtsProviderMode::FishAudio => "fish",
        TtsProviderMode::OpenAI => "openai",
        TtsProviderMode::System => "system",
        TtsProviderMode::Auto => "auto",
    }
}

fn ui_text(key: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(include_str!("../../src/locales/de/ui.json"))
    else {
        return key.to_string();
    };
    let mut current = &value;
    for segment in key.split('.') {
        let Some(next) = current.get(segment) else {
            return key.to_string();
        };
        current = next;
    }
    current.as_str().unwrap_or(key).to_string()
}

fn normalize_tts_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<&str>>().join(" ")
}

fn local_tts_endpoint_candidates(raw_endpoint: &str) -> Vec<String> {
    let trimmed = raw_endpoint.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let parsed = match Url::parse(trimmed) {
        Ok(url) => url,
        Err(_) => return vec![trimmed.to_string()],
    };

    let mut candidates = Vec::<String>::new();
    candidates.push(parsed.to_string());

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    if normalized_path.is_empty() {
        let mut v1 = parsed.clone();
        v1.set_path("/v1");
        candidates.push(v1.to_string());

        let mut audio = parsed.clone();
        audio.set_path("/v1/audio/speech");
        candidates.push(audio.to_string());
    } else if normalized_path == "/v1" {
        let mut audio = parsed;
        audio.set_path("/v1/audio/speech");
        candidates.push(audio.to_string());
    }

    let mut seen = HashSet::<String>::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

fn truncate_for_log(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    value.chars().take(max_len).collect::<String>() + "…"
}

fn should_skip_duplicate_tts_entry(
    cache: &mut HashMap<String, u64>,
    scoped_request_id: &str,
    normalized_text: &str,
) -> bool {
    if normalized_text.trim().is_empty() {
        return false;
    }

    // Bound memory growth for long-running dev sessions.
    if cache.len() > 512 {
        cache.clear();
    }

    let mut hasher = DefaultHasher::new();
    normalized_text.hash(&mut hasher);
    let fingerprint = hasher.finish();
    if cache.get(scoped_request_id) == Some(&fingerprint) {
        return true;
    }

    cache.insert(scoped_request_id.to_string(), fingerprint);
    false
}

impl TtsHttpRequestFormat {
    fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "fish" | "fishaudio" | "fish-audio" | "fish_audio" => Self::FishAudio,
            _ => Self::OpenAiCompat,
        }
    }
}

impl AppConfig {
    fn load() -> Self {
        let workspace_root = workspace_root();
        let workspace_env_path = workspace_root.join(".env");

        // Prefer project-local desktop-avatar/.env over inherited shell variables.
        if workspace_env_path.exists() {
            let _ = dotenvy::from_path_override(&workspace_env_path);
        } else {
            let _ = dotenvy::dotenv();
        }

        let default_manifest = workspace_root
            .join("public")
            .join("sample-avatar-manifest.json");
        let avatar_asset_manifest = env::var("AVATAR_ASSET_MANIFEST")
            .ok()
            .map(PathBuf::from)
            .map(|path| {
                if path.is_absolute() {
                    path
                } else {
                    workspace_root.join(path)
                }
            })
            .filter(|path| path.exists())
            .or(default_manifest
                .exists()
                .then_some(default_manifest.clone()));
        let runtime_data_dir =
            directories::ProjectDirs::from("com", "Polygonrausch", "SYNTRA Assistant")
                .map(|directories| directories.data_local_dir().to_path_buf())
                .unwrap_or_else(|| env::temp_dir().join("com.polygonrausch.desktop-avatar"));
        let _ = fs::create_dir_all(&runtime_data_dir);
        #[cfg(unix)]
        let _ = fs::set_permissions(&runtime_data_dir, fs::Permissions::from_mode(0o700));
        let log_file_path = runtime_data_dir.join("desktop-avatar.log");
        let window_state_path = runtime_data_dir.join("desktop-avatar-window-state.json");

        reset_log_file(&log_file_path);

        let tts_provider = env::var("TTS_PROVIDER")
            .map(|value| TtsProviderMode::parse(&value))
            .unwrap_or(TtsProviderMode::Auto);
        let transcription_provider_default = env::var("TRANSCRIPTION_PROVIDER_DEFAULT")
            .ok()
            .as_deref()
            .and_then(|value| TranscriptionProviderId::parse(value).ok())
            .unwrap_or(TranscriptionProviderId::OpenAiRealtime);
        let transcription_provider_fallback = env::var("TRANSCRIPTION_PROVIDER_FALLBACK")
            .ok()
            .as_deref()
            .and_then(|value| TranscriptionProviderId::parse(value).ok())
            .or_else(|| {
                (transcription_provider_default == TranscriptionProviderId::OpenAiRealtime)
                    .then_some(TranscriptionProviderId::OpenAiFileFallback)
            });

        let openai_tts_default_voice =
            env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "shimmer".to_string());
        let mut openai_tts_voices = env::var("OPENAI_TTS_VOICES")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        if openai_tts_voices.is_empty() {
            openai_tts_voices.push(openai_tts_default_voice.clone());
        } else if !openai_tts_voices.contains(&openai_tts_default_voice) {
            openai_tts_voices.push(openai_tts_default_voice.clone());
        }

        let local_tts_default_voice =
            env::var("LOCAL_TTS_VOICE").unwrap_or_else(|_| "de_male".to_string());
        let mut local_tts_voices = env::var("LOCAL_TTS_VOICES")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        if local_tts_voices.is_empty() {
            local_tts_voices.push(local_tts_default_voice.clone());
        }

        let local_tts_url = env::var("LOCAL_TTS_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let local_tts_request_format = env::var("LOCAL_TTS_REQUEST_FORMAT")
            .map(|value| TtsHttpRequestFormat::parse(&value))
            .unwrap_or(TtsHttpRequestFormat::OpenAiCompat);
        let local_tts_request_template = env::var("LOCAL_TTS_REQUEST_TEMPLATE")
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(raw.trim()).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| default_local_tts_request_template(local_tts_request_format));
        let local_tts_response_base64_path = env::var("LOCAL_TTS_RESPONSE_BASE64_PATH")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let local_tts_headers = env::var("LOCAL_TTS_HEADERS")
            .ok()
            .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(raw.trim()).ok())
            .unwrap_or_default();

        Self {
            comm_officer_base_url: env::var("COMM_OFFICER_BASE_URL").ok(),
            comm_officer_csrf_cookie_name: env::var("COMM_OFFICER_CSRF_COOKIE_NAME")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            openai_stt_model: env::var("OPENAI_STT_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-transcribe".to_string()),
            transcription_provider_default,
            transcription_provider_fallback,
            openai_realtime_stt_model: env::var("OPENAI_REALTIME_STT_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-transcribe".to_string()),
            tts_provider,
            openai_tts_enabled: env::var("OPENAI_TTS_ENABLED")
                .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
                .unwrap_or(true),
            openai_tts_model: env::var("OPENAI_TTS_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-tts".to_string()),
            openai_tts_default_voice,
            openai_tts_voices,
            local_tts_url,
            local_tts_api_key: env::var("LOCAL_TTS_API_KEY").ok(),
            local_tts_model: env::var("LOCAL_TTS_MODEL").unwrap_or_else(|_| "kokoro".to_string()),
            local_tts_default_voice,
            local_tts_voices,
            local_tts_request_template,
            local_tts_response_base64_path,
            local_tts_headers,
            avatar_asset_manifest,
            log_file_path,
            window_state_path,
            enable_tts: env::var("ENABLE_TTS")
                .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
                .unwrap_or(true),
        }
    }

    fn openai_tts_available(&self) -> bool {
        self.openai_tts_enabled
            && self
                .openai_api_key
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some()
    }

    fn local_tts_available(&self) -> bool {
        self.local_tts_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    }

    fn fish_tts_available(&self) -> bool {
        self.local_tts_available()
    }
}

fn default_local_tts_request_template(format: TtsHttpRequestFormat) -> Value {
    match format {
        TtsHttpRequestFormat::OpenAiCompat => json!({
            "model": "{{model}}",
            "voice": "{{voice}}",
            "input": "{{input}}"
        }),
        TtsHttpRequestFormat::FishAudio => json!({
            "text": "{{input}}",
            "speaker": "{{voice}}",
            "model": "{{model}}"
        }),
    }
}

fn render_tts_request_template(template: &Value, input: &str, voice: &str, model: &str) -> Value {
    match template {
        Value::String(raw) => Value::String(
            raw.replace("{{input}}", input)
                .replace("{{voice}}", voice)
                .replace("{{model}}", model),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|value| render_tts_request_template(value, input, voice, model))
                .collect(),
        ),
        Value::Object(map) => {
            let mut next = serde_json::Map::with_capacity(map.len());
            for (key, value) in map {
                next.insert(
                    key.clone(),
                    render_tts_request_template(value, input, voice, model),
                );
            }
            Value::Object(next)
        }
        _ => template.clone(),
    }
}

fn lookup_json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path
        .split('.')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
    {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.as_array()?.get(index)?;
            continue;
        }
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn decode_json_tts_audio(
    body: &[u8],
    provider_name: &str,
    response_base64_path: Option<&str>,
) -> Result<Vec<u8>, String> {
    let value = serde_json::from_slice::<Value>(body).map_err(|error| {
        format!("{provider_name} TTS returned JSON payload that could not be parsed: {error}")
    })?;

    let mut paths: Vec<String> = Vec::new();
    if let Some(path) = response_base64_path {
        paths.push(path.to_string());
    }
    paths.extend(
        [
            "audio",
            "audio_base64",
            "data",
            "data.audio",
            "output.audio",
            "result.audio",
        ]
        .into_iter()
        .map(str::to_string),
    );

    for path in paths {
        let raw = match lookup_json_path(&value, &path) {
            Some(Value::String(raw)) => raw.trim(),
            _ => continue,
        };
        if raw.is_empty() {
            continue;
        }
        let encoded = raw
            .split_once(',')
            .map(|(_, suffix)| suffix)
            .unwrap_or(raw)
            .trim();
        if encoded.is_empty() {
            continue;
        }
        if let Ok(decoded) = BASE64.decode(encoded.as_bytes()) {
            if !decoded.is_empty() {
                return Ok(decoded);
            }
        }
    }

    Err(format!(
        "{provider_name} TTS returned JSON but no decodable base64 audio payload was found. Configure LOCAL_TTS_RESPONSE_BASE64_PATH when required.",
    ))
}

#[tauri::command]
async fn load_bootstrap_state(state: State<'_, AppState>) -> Result<BootstrapState, String> {
    append_log(
        &state.config.log_file_path,
        "bootstrap: avatar manifest resolution started",
    );

    let avatar_manifest = match &state.config.avatar_asset_manifest {
        Some(path) if path.exists() => {
            let data = fs::read_to_string(path).map_err(|error| error.to_string())?;
            let mut manifest =
                serde_json::from_str::<AvatarManifest>(&data).map_err(|error| error.to_string())?;
            if let Some(base_dir) = path.parent() {
                resolve_avatar_manifest_paths(&mut manifest, base_dir);
            }
            append_log(
                &state.config.log_file_path,
                format!(
                    "bootstrap: avatar manifest loaded model={} vrm={} idleClipCount={}",
                    manifest.model_url.is_some(),
                    manifest.vrm_url.is_some(),
                    manifest.idle_animation_urls.len()
                ),
            );
            Some(manifest)
        }
        Some(_path) => {
            append_log(
                &state.config.log_file_path,
                "bootstrap: avatar manifest missing",
            );
            None
        }
        None => {
            append_log(
                &state.config.log_file_path,
                "bootstrap: no avatar manifest configured",
            );
            None
        }
    };

    Ok(BootstrapState {
        avatar_manifest,
        collapsed_size: WindowSize {
            width: DEFAULT_PEEK_WIDTH,
            height: DEFAULT_PEEK_HEIGHT,
        },
        expanded_size: WindowSize {
            width: EXPANDED_WIDTH,
            height: EXPANDED_HEIGHT,
        },
        tts_enabled: state.config.enable_tts,
        transcription_provider: transcription_provider_label(
            *state.transcription_provider.lock().await,
        )
        .to_string(),
        transcription_providers: vec![
            transcription_provider_label(TranscriptionProviderId::OpenAiRealtime).to_string(),
            transcription_provider_label(TranscriptionProviderId::OpenAiFileFallback).to_string(),
        ],
    })
}

#[tauri::command]
async fn load_avatar_asset(path: String) -> Result<AssetPayload, String> {
    if is_remote_url(&path) {
        return load_remote_avatar_asset(path).await;
    }

    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    Ok(AssetPayload {
        mime_type: mime_type_for_path(&path),
        base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
async fn frontend_log(
    state: State<'_, AppState>,
    level: String,
    message: String,
) -> Result<(), String> {
    drop(message);
    let safe_level = match level.trim().to_ascii_lowercase().as_str() {
        "debug" => "debug",
        "info" => "info",
        "warn" => "warn",
        "error" => "error",
        _ => "unknown",
    };
    append_log(
        &state.config.log_file_path,
        format!("frontend:{safe_level}: redacted-event"),
    );
    Ok(())
}

#[tauri::command]
async fn window_resize(
    window: WebviewWindow,
    width: f64,
    height: f64,
    anchor: Option<WindowResizeAnchor>,
) -> Result<(), String> {
    resize_window_internal(
        &window,
        width,
        height,
        anchor.unwrap_or(WindowResizeAnchor::Left),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    screen_width: f64,
    screen_height: f64,
}

#[tauri::command]
async fn window_get_geometry(window: WebviewWindow) -> Result<WindowGeometry, String> {
    let rect = current_window_rect(&window)?;
    let (screen_width, screen_height) = monitor_logical_size(&window)?;
    Ok(WindowGeometry {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        screen_width,
        screen_height,
    })
}

#[tauri::command]
async fn window_start_drag(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mode: Option<String>,
) -> Result<(), String> {
    let dragged_mode = if mode
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("peek"))
    {
        WindowMode::Peek
    } else if mode
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("expanded"))
    {
        WindowMode::Expanded
    } else {
        *state.current_window_mode.lock().await
    };

    {
        let mut guard = state.drag_tracking_mode.lock().await;
        *guard = Some(dragged_mode);
    }
    let drag_revision = {
        let mut guard = state.drag_tracking_revision.lock().await;
        *guard += 1;
        *guard
    };
    let drag_tracking_mode = state.drag_tracking_mode.clone();
    let drag_tracking_revision = state.drag_tracking_revision.clone();
    let app_state = state.inner().clone();
    let tracked_window = window.clone();
    async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(260)).await;
        let current_revision = *drag_tracking_revision.lock().await;
        if current_revision != drag_revision {
            return;
        }
        let active_mode = *drag_tracking_mode.lock().await;
        let Some(active_mode) = active_mode else {
            return;
        };
        let Ok(rect) = current_window_rect(&tracked_window) else {
            let mut guard = drag_tracking_mode.lock().await;
            *guard = None;
            return;
        };
        match active_mode {
            WindowMode::Peek => {
                let peek_size = *app_state.peek_size.lock().await;
                let mut guard = app_state.last_peek_rect.lock().await;
                *guard = peek_rect_for_origin(&tracked_window, rect.x, rect.y, peek_size).ok();
            }
            WindowMode::Expanded => {
                let mut guard = app_state.last_expanded_rect.lock().await;
                *guard = clamp_window_rect_to_monitor(&tracked_window, rect).ok();
            }
        }
        {
            let mut guard = drag_tracking_mode.lock().await;
            *guard = None;
        }
        persist_window_state(&app_state).await;
    });

    window.start_dragging().map_err(|error| error.to_string())?;
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn ease_out_cubic(value: f64) -> f64 {
    1.0 - (1.0 - value).powi(3)
}

fn rect_origin_delta(a: WindowRect, b: WindowRect) -> f64 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

fn current_window_rect(window: &WebviewWindow) -> Result<WindowRect, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    if scale_factor <= 0.0 {
        return Err("Invalid window scale factor".to_string());
    }
    Ok(WindowRect {
        x: position.x as f64 / scale_factor,
        y: position.y as f64 / scale_factor,
        width: size.width as f64 / scale_factor,
        height: size.height as f64 / scale_factor,
    })
}

fn read_persisted_window_state(path: &Path) -> PersistedWindowState {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PersistedWindowState>(&raw).ok())
        .unwrap_or_default()
}

fn write_persisted_window_state(path: &Path, value: &PersistedWindowState) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(parent);
    let Ok(serialized) = serde_json::to_string_pretty(value) else {
        return;
    };
    let _ = fs::write(path, serialized);
}

fn startup_peek_origin(state: &PersistedWindowState) -> Option<(f64, f64)> {
    state.last_peek_rect.map(|rect| (rect.x, rect.y))
}

async fn persist_window_state(state: &AppState) {
    let snapshot = PersistedWindowState {
        peek_position: *state.peek_position.lock().await,
        peek_size: *state.peek_size.lock().await,
        last_peek_rect: *state.last_peek_rect.lock().await,
        last_expanded_rect: *state.last_expanded_rect.lock().await,
    };
    write_persisted_window_state(&state.config.window_state_path, &snapshot);
}

fn apply_window_rect(window: &WebviewWindow, rect: WindowRect) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(rect.width, rect.height)))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Logical(LogicalPosition::new(rect.x, rect.y)))
        .map_err(|error| error.to_string())
}

fn monitor_logical_size(window: &WebviewWindow) -> Result<(f64, f64), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No monitor available".to_string())?;
    let scale_factor = monitor.scale_factor();
    let size = monitor.size();
    Ok((
        size.width as f64 / scale_factor,
        size.height as f64 / scale_factor,
    ))
}

fn normalize_peek_size(width: f64, height: f64) -> WindowSize {
    let diameter = width
        .min(height)
        .clamp(150.0, MAX_PEEK_WIDTH.min(MAX_PEEK_HEIGHT));
    WindowSize {
        width: diameter,
        height: diameter,
    }
}

fn clamp_window_rect_to_monitor(
    window: &WebviewWindow,
    rect: WindowRect,
) -> Result<WindowRect, String> {
    let (screen_width, screen_height) = monitor_logical_size(window)?;
    Ok(WindowRect {
        x: rect.x.clamp(0.0, (screen_width - rect.width).max(0.0)),
        y: rect.y.clamp(0.0, (screen_height - rect.height).max(0.0)),
        width: rect.width,
        height: rect.height,
    })
}

fn peek_rect_for_position(
    window: &WebviewWindow,
    position: PeekPosition,
    peek_size: WindowSize,
) -> Result<WindowRect, String> {
    let (screen_width, screen_height) = monitor_logical_size(window)?;
    let x = match position {
        PeekPosition::TopLeft | PeekPosition::BottomLeft => PEEK_WINDOW_MARGIN,
        PeekPosition::TopRight | PeekPosition::BottomRight => {
            (screen_width - peek_size.width - PEEK_WINDOW_MARGIN).max(PEEK_WINDOW_MARGIN)
        }
    };
    let y = match position {
        PeekPosition::TopLeft | PeekPosition::TopRight => PEEK_WINDOW_MARGIN,
        PeekPosition::BottomLeft | PeekPosition::BottomRight => {
            (screen_height - peek_size.height - PEEK_WINDOW_MARGIN).max(PEEK_WINDOW_MARGIN)
        }
    };
    Ok(WindowRect {
        x,
        y,
        width: peek_size.width,
        height: peek_size.height,
    })
}

fn peek_rect_for_origin(
    window: &WebviewWindow,
    x: f64,
    y: f64,
    peek_size: WindowSize,
) -> Result<WindowRect, String> {
    clamp_window_rect_to_monitor(
        window,
        WindowRect {
            x,
            y,
            width: peek_size.width,
            height: peek_size.height,
        },
    )
}

fn expanded_rect_for_position(
    window: &WebviewWindow,
    position: PeekPosition,
    width: f64,
    height: f64,
) -> Result<WindowRect, String> {
    let (screen_width, screen_height) = monitor_logical_size(window)?;
    let x = match position {
        PeekPosition::TopLeft | PeekPosition::BottomLeft => EXPANDED_WINDOW_MARGIN,
        PeekPosition::TopRight | PeekPosition::BottomRight => {
            (screen_width - width - EXPANDED_WINDOW_MARGIN).max(EXPANDED_WINDOW_MARGIN)
        }
    };
    let y = match position {
        PeekPosition::TopLeft | PeekPosition::TopRight => EXPANDED_WINDOW_MARGIN,
        PeekPosition::BottomLeft | PeekPosition::BottomRight => {
            (screen_height - height - EXPANDED_WINDOW_MARGIN).max(EXPANDED_WINDOW_MARGIN)
        }
    };
    Ok(WindowRect {
        x,
        y,
        width,
        height,
    })
}

fn expanded_rect_for_origin(
    window: &WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<WindowRect, String> {
    clamp_window_rect_to_monitor(
        window,
        WindowRect {
            x,
            y,
            width,
            height,
        },
    )
}

async fn animate_window_rect(
    window: &WebviewWindow,
    from: WindowRect,
    to: WindowRect,
    duration_ms: u64,
) -> Result<(), String> {
    for step in 1..=TRANSITION_STEPS {
        let progress = step as f64 / TRANSITION_STEPS as f64;
        let eased = ease_out_cubic(progress);
        let frame = WindowRect {
            x: from.x + (to.x - from.x) * eased,
            y: from.y + (to.y - from.y) * eased,
            width: from.width + (to.width - from.width) * eased,
            height: from.height + (to.height - from.height) * eased,
        };
        apply_window_rect(window, frame)?;
        let per_step = (duration_ms / TRANSITION_STEPS as u64).max(8);
        tokio::time::sleep(std::time::Duration::from_millis(per_step)).await;
    }
    apply_window_rect(window, to)
}

#[tauri::command]
async fn window_set_peek_position(
    window: WebviewWindow,
    state: State<'_, AppState>,
    position: PeekPosition,
) -> Result<(), String> {
    {
        let mut guard = state.peek_position.lock().await;
        *guard = position;
    }
    let peek_size = *state.peek_size.lock().await;
    let snapped_target = peek_rect_for_position(&window, position, peek_size)?;
    {
        let mut guard = state.last_peek_rect.lock().await;
        *guard = Some(snapped_target);
    }
    let current = current_window_rect(&window)?;
    if current.width <= MAX_PEEK_WIDTH + 2.0 && current.height <= MAX_PEEK_HEIGHT + 2.0 {
        apply_window_rect(&window, snapped_target)?;
    }
    persist_window_state(state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn window_set_peek_mode(
    window: WebviewWindow,
    state: State<'_, AppState>,
    mode: String,
    width: Option<f64>,
    height: Option<f64>,
    collapsed_width: Option<f64>,
    collapsed_height: Option<f64>,
    animated: Option<bool>,
    show_if_hidden: Option<bool>,
) -> Result<(), String> {
    let animate = animated.unwrap_or(true);
    let show_if_hidden = show_if_hidden.unwrap_or(false);
    let next_mode = if mode.trim().eq_ignore_ascii_case("peek") {
        WindowMode::Peek
    } else {
        WindowMode::Expanded
    };
    let current = current_window_rect(&window)?;
    let current_peek_size = *state.peek_size.lock().await;
    let requested_peek_size = normalize_peek_size(
        collapsed_width.unwrap_or(current_peek_size.width),
        collapsed_height.unwrap_or(current_peek_size.height),
    );
    {
        let mut guard = state.peek_size.lock().await;
        *guard = requested_peek_size;
    }
    let current_mode = *state.current_window_mode.lock().await;
    match current_mode {
        WindowMode::Peek => {
            let mut guard = state.last_peek_rect.lock().await;
            *guard = Some(current);
        }
        WindowMode::Expanded => {
            let mut guard = state.last_expanded_rect.lock().await;
            *guard = Some(current);
        }
    }

    let target = if next_mode == WindowMode::Peek {
        if let Some(saved_rect) = *state.last_peek_rect.lock().await {
            peek_rect_for_origin(&window, saved_rect.x, saved_rect.y, requested_peek_size)?
        } else {
            let position = *state.peek_position.lock().await;
            if current_mode == WindowMode::Expanded {
                peek_rect_for_origin(&window, current.x, current.y, requested_peek_size)?
            } else {
                peek_rect_for_position(&window, position, requested_peek_size)?
            }
        }
    } else {
        let target_width = width.unwrap_or(EXPANDED_WIDTH).max(420.0);
        let target_height = height.unwrap_or(EXPANDED_HEIGHT).max(420.0);
        if let Some(saved_rect) = *state.last_expanded_rect.lock().await {
            expanded_rect_for_origin(
                &window,
                saved_rect.x,
                saved_rect.y,
                target_width,
                target_height,
            )?
        } else {
            expanded_rect_for_origin(&window, current.x, current.y, target_width, target_height)?
        }
    };

    {
        let mut guard = state.suppress_window_tracking.lock().await;
        *guard = true;
    }
    let transition_result = if animate && current_mode != next_mode {
        let stage_target = match next_mode {
            WindowMode::Peek => {
                peek_rect_for_origin(&window, current.x, current.y, requested_peek_size)?
            }
            WindowMode::Expanded => expanded_rect_for_origin(
                &window,
                current.x,
                current.y,
                target.width,
                target.height,
            )?,
        };
        if rect_origin_delta(stage_target, target) <= 1.0 {
            animate_window_rect(&window, current, target, TRANSITION_DURATION_MS).await
        } else {
            animate_window_rect(&window, current, stage_target, TRANSITION_STAGE_DURATION_MS)
                .await?;
            apply_window_rect(&window, target)
        }
    } else if animate {
        animate_window_rect(&window, current, target, TRANSITION_DURATION_MS).await
    } else {
        apply_window_rect(&window, target)
    };
    if let Err(error) = transition_result {
        let mut guard = state.suppress_window_tracking.lock().await;
        *guard = false;
        return Err(error);
    }
    match next_mode {
        WindowMode::Peek => {
            let mut guard = state.last_peek_rect.lock().await;
            *guard = Some(target);
        }
        WindowMode::Expanded => {
            let mut guard = state.last_expanded_rect.lock().await;
            *guard = Some(target);
        }
    }
    {
        let mut guard = state.current_window_mode.lock().await;
        *guard = next_mode;
    }
    {
        let mut guard = state.suppress_window_tracking.lock().await;
        *guard = false;
    }
    if show_if_hidden && !window.is_visible().map_err(|error| error.to_string())? {
        let _ = window.show();
    }
    persist_window_state(state.inner()).await;
    Ok(())
}

fn agent_studio_broker(
    state: &AppState,
) -> Result<Arc<AgentStudioSessionBroker>, AgentStudioApiError> {
    state.agent_studio.clone()
}

fn update_tray_tenant(app: &AppHandle, session: Option<&DesktopAvatarTenantSession>) {
    let tooltip = session
        .map(|value| {
            let tenant = &value.public_session.selected_tenant;
            format!(
                "SYNTRA Assistant — {} · {}",
                tenant.company_name, tenant.branch_name
            )
        })
        .unwrap_or_else(|| "SYNTRA Assistant — Anmeldung erforderlich".to_string());
    if let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

async fn reset_agent_studio_activity(state: &AppState) {
    state.tts_generation.fetch_add(1, Ordering::SeqCst);
    let request_handles = {
        let mut streams = state.desktop_avatar_streams.lock().await;
        streams
            .drain()
            .map(|(_, owned)| owned.handle)
            .collect::<Vec<_>>()
    };
    for handle in request_handles {
        handle.abort();
    }
    if let Some(owned) = state.desktop_avatar_radar_stream.lock().await.take() {
        owned.handle.abort();
    }
    if let Some(owned) = state.hitl_decision_stream.lock().await.take() {
        owned.handle.abort();
    }
    state.last_tts_text_by_request.lock().await.clear();
    state.transcription_sessions.lock().await.clear();
    cancel_tts_processes(state).await;
    cleanup_tts_temp_files();
}

async fn cancel_tts_processes(state: &AppState) {
    let handles = {
        let mut processes = state.tts_processes.lock().await;
        processes
            .drain()
            .map(|(_, handle)| handle)
            .collect::<Vec<_>>()
    };
    cancel_tts_process_handles(handles).await;
}

async fn cancel_tts_process_handles(handles: Vec<TtsProcessHandle>) {
    for handle in handles {
        let _ = handle.cancel.send(());
        let _ = handle.stopped.await;
    }
}

fn cleanup_tts_temp_files() {
    let Ok(entries) = fs::read_dir(env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("desktop-avatar-tts-"))
        {
            let _ = fs::remove_file(path);
        }
    }
}

#[tauri::command]
async fn auth_preauthenticate(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AuthCredentialsInput,
) -> Result<AuthPreauthenticateResult, AgentStudioApiError> {
    let broker = agent_studio_broker(state.inner())?;
    broker
        .preauthenticate_with_invalidation(&input.username, &input.password, || async {
            reset_agent_studio_activity(state.inner()).await;
            update_tray_tenant(&app, None);
        })
        .await
}

#[tauri::command]
async fn auth_companies(
    state: State<'_, AppState>,
) -> Result<Vec<AuthCompanySummary>, AgentStudioApiError> {
    agent_studio_broker(state.inner())?.companies().await
}

#[tauri::command]
async fn auth_branches(
    state: State<'_, AppState>,
    company_id: String,
) -> Result<Vec<AuthBranchSummary>, AgentStudioApiError> {
    agent_studio_broker(state.inner())?
        .branches(&company_id)
        .await
}

#[tauri::command]
async fn auth_complete(
    app: AppHandle,
    state: State<'_, AppState>,
    input: AuthCompleteInput,
) -> Result<DesktopAvatarTenantSession, AgentStudioApiError> {
    reset_agent_studio_activity(state.inner()).await;
    let session = agent_studio_broker(state.inner())?
        .complete(&input.company_id, &input.branch_id)
        .await?;
    update_tray_tenant(&app, Some(&session));
    Ok(session)
}

#[tauri::command]
async fn auth_session_get(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<DesktopAvatarTenantSession, AgentStudioApiError> {
    let broker = agent_studio_broker(state.inner())?;
    match broker
        .session_with_invalidation(|| async {
            reset_agent_studio_activity(state.inner()).await;
            update_tray_tenant(&app, None);
        })
        .await
    {
        Ok(session) => {
            update_tray_tenant(&app, Some(&session));
            Ok(session)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn auth_logout(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AgentStudioApiError> {
    let broker = agent_studio_broker(state.inner())?;
    broker
        .logout_with_invalidation(|| async {
            reset_agent_studio_activity(state.inner()).await;
            update_tray_tenant(&app, None);
        })
        .await
        .map(|_| ())
}

#[tauri::command]
async fn desktop_avatar_request_create(
    state: State<'_, AppState>,
    request: CreateDesktopAvatarRequestInput,
    expected_context_id: String,
) -> Result<CreateDesktopAvatarRequestResult, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let result = execution
        .api
        .post_json::<_, CreateDesktopAvatarRequestResult>("/v1/desktop-avatar/requests", &request)
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(result)
}

#[tauri::command]
async fn desktop_avatar_request_get(
    state: State<'_, AppState>,
    avatar_request_id: Option<String>,
    poll_url: Option<String>,
    expected_context_id: String,
) -> Result<DesktopAvatarRequestDocument, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = match (avatar_request_id, poll_url) {
        (_, Some(url)) => url,
        (Some(request_id), None) => format!("/v1/desktop-avatar/requests/{request_id}"),
        (None, None) => {
            return Err(
                "desktop_avatar_request_get requires avatarRequestId or pollUrl.".to_string(),
            )
        }
    };
    let document = execution
        .api
        .get_json::<DesktopAvatarRequestDocument>(&url)
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(document)
}

#[tauri::command]
async fn desktop_avatar_radar_get(
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<Value, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let radar = execution
        .api
        .get_json::<Value>("/v1/desktop-avatar/radar")
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(radar)
}

#[tauri::command]
async fn desktop_avatar_radar_stream_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let api = execution.api;
    let slot = state.desktop_avatar_radar_stream.clone();
    let owner_id = uuid::Uuid::new_v4().to_string();
    let task_owner_id = owner_id.clone();
    let task_context_id = session.context_id.clone();
    let task_broker = broker.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            if let Some(existing) = slot.lock().await.take() {
                existing.handle.abort();
            }
            let (registered_tx, registered_rx) = oneshot::channel();
            let task_slot = slot.clone();
            let handle = async_runtime::spawn(async move {
                let _ = registered_rx.await;
                let response = api.open_stream("/v1/desktop-avatar/radar/stream").await;

                match response {
                    Ok(response) => {
                        if let Err(error) = process_desktop_avatar_radar_stream(
                            window.clone(),
                            response,
                            task_broker.clone(),
                            session.clone(),
                        )
                        .await
                        {
                            let _ = emit_desktop_avatar_radar_stream_lifecycle(
                                &window,
                                &session.context_id,
                                "error",
                                Some(error),
                            );
                        } else {
                            let _ = emit_desktop_avatar_radar_stream_lifecycle(
                                &window,
                                &session.context_id,
                                "closed",
                                None,
                            );
                        }
                    }
                    Err(error) => {
                        let _ = emit_desktop_avatar_radar_stream_lifecycle(
                            &window,
                            &session.context_id,
                            "error",
                            Some(error.to_string()),
                        );
                    }
                }

                let mut current = task_slot.lock().await;
                take_stream_if_owner(&mut current, &task_owner_id);
            });
            *slot.lock().await = Some(OwnedStreamHandle {
                owner_id,
                context_id: task_context_id,
                handle,
            });
            let _ = registered_tx.send(());
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_avatar_radar_stream_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let slot = state.desktop_avatar_radar_stream.clone();
    let context_id = expected_context_id.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            let mut current = slot.lock().await;
            if current
                .as_ref()
                .is_some_and(|owned| owned.context_id == context_id)
            {
                if let Some(owned) = current.take() {
                    owned.handle.abort();
                }
            }
            emit_desktop_avatar_radar_stream_lifecycle(&window, &context_id, "aborted", None)
                .map_err(|error| AgentStudioApiError::local("STREAM_EVENT_FAILED", error))
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_avatar_request_stream(
    window: WebviewWindow,
    state: State<'_, AppState>,
    avatar_request_id: Option<String>,
    stream_url: Option<String>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let request_id = avatar_request_id
        .or_else(|| {
            stream_url.as_ref().and_then(|value| {
                value
                    .trim_end_matches('/')
                    .split('/')
                    .nth_back(1)
                    .map(str::to_string)
            })
        })
        .ok_or_else(|| {
            "desktop_avatar_request_stream requires avatarRequestId or a streamUrl containing it."
                .to_string()
        })?;
    let url = match stream_url {
        Some(url) => url,
        None => format!("/v1/desktop-avatar/requests/{request_id}/stream"),
    };

    let api = execution.api;
    let streams = state.desktop_avatar_streams.clone();
    let owner_id = uuid::Uuid::new_v4().to_string();
    let task_owner_id = owner_id.clone();
    let task_context_id = session.context_id.clone();
    let request_id_for_task = request_id.clone();
    let task_broker = broker.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            if let Some(existing) = streams.lock().await.remove(request_id.as_str()) {
                existing.handle.abort();
            }
            let (registered_tx, registered_rx) = oneshot::channel();
            let task_streams = streams.clone();
            let handle = async_runtime::spawn(async move {
                let _ = registered_rx.await;
                let response = api.open_stream(&url).await;

                match response {
                    Ok(response) => {
                        if let Err(error) = process_desktop_avatar_stream(
                            window.clone(),
                            request_id_for_task.clone(),
                            response,
                            task_broker.clone(),
                            session.clone(),
                        )
                        .await
                        {
                            let _ = emit_desktop_avatar_stream_lifecycle(
                                &window,
                                &session.context_id,
                                request_id_for_task.as_str(),
                                "error",
                                Some(error),
                            );
                        } else {
                            let _ = emit_desktop_avatar_stream_lifecycle(
                                &window,
                                &session.context_id,
                                request_id_for_task.as_str(),
                                "closed",
                                None,
                            );
                        }
                    }
                    Err(error) => {
                        let _ = emit_desktop_avatar_stream_lifecycle(
                            &window,
                            &session.context_id,
                            request_id_for_task.as_str(),
                            "error",
                            Some(error.to_string()),
                        );
                    }
                }

                let mut current = task_streams.lock().await;
                remove_stream_if_owner(&mut current, request_id_for_task.as_str(), &task_owner_id);
            });
            streams.lock().await.insert(
                request_id,
                OwnedStreamHandle {
                    owner_id,
                    context_id: task_context_id,
                    handle,
                },
            );
            let _ = registered_tx.send(());
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_avatar_request_stream_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    avatar_request_id: String,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let streams = state.desktop_avatar_streams.clone();
    let context_id = expected_context_id.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            let mut current = streams.lock().await;
            if current
                .get(avatar_request_id.as_str())
                .is_some_and(|owned| owned.context_id == context_id)
            {
                if let Some(owned) = current.remove(avatar_request_id.as_str()) {
                    owned.handle.abort();
                }
            }
            emit_desktop_avatar_stream_lifecycle(
                &window,
                &context_id,
                avatar_request_id.as_str(),
                "aborted",
                None,
            )
            .map_err(|error| AgentStudioApiError::local("STREAM_EVENT_FAILED", error))
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn hitl_decision_stream_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let api = execution.api;
    let slot = state.hitl_decision_stream.clone();
    let owner_id = uuid::Uuid::new_v4().to_string();
    let task_owner_id = owner_id.clone();
    let task_context_id = session.context_id.clone();
    let task_broker = broker.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            if let Some(existing) = slot.lock().await.take() {
                existing.handle.abort();
            }
            let (registered_tx, registered_rx) = oneshot::channel();
            let task_slot = slot.clone();
            let handle = async_runtime::spawn(async move {
                let _ = registered_rx.await;
                let response = api.open_stream("/v1/hitl/decision-events/stream").await;

                match response {
                    Ok(response) => {
                        if let Err(error) = process_hitl_decision_stream(
                            window.clone(),
                            response,
                            task_broker.clone(),
                            session.clone(),
                        )
                        .await
                        {
                            let _ = emit_hitl_decision_stream_lifecycle(
                                &window,
                                &session.context_id,
                                "error",
                                Some(error),
                            );
                        } else {
                            let _ = emit_hitl_decision_stream_lifecycle(
                                &window,
                                &session.context_id,
                                "closed",
                                None,
                            );
                        }
                    }
                    Err(error) => {
                        let _ = emit_hitl_decision_stream_lifecycle(
                            &window,
                            &session.context_id,
                            "error",
                            Some(error.to_string()),
                        );
                    }
                }

                let mut current = task_slot.lock().await;
                take_stream_if_owner(&mut current, &task_owner_id);
            });
            *slot.lock().await = Some(OwnedStreamHandle {
                owner_id,
                context_id: task_context_id,
                handle,
            });
            let _ = registered_tx.send(());
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn hitl_decision_stream_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let slot = state.hitl_decision_stream.clone();
    let context_id = expected_context_id.clone();
    broker
        .run_if_current(&expected_context_id, || async move {
            let mut current = slot.lock().await;
            if current
                .as_ref()
                .is_some_and(|owned| owned.context_id == context_id)
            {
                if let Some(owned) = current.take() {
                    owned.handle.abort();
                }
            }
            emit_hitl_decision_stream_lifecycle(&window, &context_id, "aborted", None)
                .map_err(|error| AgentStudioApiError::local("STREAM_EVENT_FAILED", error))
        })
        .await
        .map_err(|error| error.to_string())
}

fn hitl_idempotency_key(prefix: &str, run_id: &str, proposal_id: Option<&str>) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!(
        "desktop-avatar-{prefix}-{run_id}-{}-{millis}",
        proposal_id.unwrap_or("run")
    )
}

async fn post_hitl_decision(
    state: State<'_, AppState>,
    input: HitlDecisionInput,
    approved: bool,
    expected_context_id: &str,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = format!(
        "/v1/runs/{}/proposals/{}/decision",
        input.run_id, input.proposal_id
    );
    let body = json!({
        "approved": approved,
        "decisionReason": input.decision_reason,
    });
    let idempotency_key = hitl_idempotency_key(
        if approved { "approve" } else { "reject" },
        input.run_id.as_str(),
        Some(input.proposal_id.as_str()),
    );
    let _: Value = execution
        .api
        .post_json_with_idempotency(&url, &body, &idempotency_key)
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn hitl_decision_approve(
    state: State<'_, AppState>,
    input: HitlDecisionInput,
    expected_context_id: String,
) -> Result<(), String> {
    post_hitl_decision(state, input, true, &expected_context_id).await
}

#[tauri::command]
async fn hitl_decision_reject(
    state: State<'_, AppState>,
    input: HitlDecisionInput,
    expected_context_id: String,
) -> Result<(), String> {
    post_hitl_decision(state, input, false, &expected_context_id).await
}

#[tauri::command]
async fn hitl_request_more_info(
    state: State<'_, AppState>,
    input: HitlRequestMoreInfoInput,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = format!("/v1/runs/{}/request-more-info", input.run_id);
    let idempotency_key = hitl_idempotency_key("more-info", input.run_id.as_str(), None);
    let _: Value = execution
        .api
        .post_json_with_idempotency(
            &url,
            &json!({ "message": input.message, "autoProcess": true }),
            &idempotency_key,
        )
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn speech_transcribe(
    state: State<'_, AppState>,
    request: SpeechTranscriptionRequest,
    expected_context_id: String,
) -> Result<String, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let audio = BASE64
        .decode(request.audio_base64.as_bytes())
        .map_err(|error| error.to_string())?;
    let transcript = transcribe_with_openai_file_api(
        state.inner(),
        &audio,
        request.mime_type.as_str(),
        request.locale.as_deref(),
    )
    .await?;
    ensure_stream_current(&broker, &session).await?;
    Ok(transcript)
}

fn build_transcription_provider_chain(
    selected: TranscriptionProviderId,
    fallback: Option<TranscriptionProviderId>,
) -> Vec<TranscriptionProviderId> {
    let mut chain = vec![selected];
    if let Some(next) = fallback {
        if next != selected {
            chain.push(next);
        }
    }
    chain
}

fn wrap_pcm16le_as_wav(bytes: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let bits_per_sample: u16 = 16;
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let data_len = bytes.len() as u32;
    let mut out = Vec::with_capacity(44 + bytes.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36u32.saturating_add(data_len)).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // audio format PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

async fn transcribe_with_openai_file_api(
    state: &AppState,
    audio: &[u8],
    mime_type: &str,
    locale: Option<&str>,
) -> Result<String, String> {
    let api_key = state
        .config
        .openai_api_key
        .clone()
        .ok_or_else(|| "OPENAI_API_KEY is missing.".to_string())?;
    let normalized_mime = normalize_audio_mime_for_transcription(mime_type);
    let (payload, payload_mime, extension) = if normalized_mime == "audio/pcm" {
        (
            wrap_pcm16le_as_wav(audio, 24_000, 1),
            "audio/wav".to_string(),
            "wav".to_string(),
        )
    } else {
        (
            audio.to_vec(),
            normalized_mime.clone(),
            mime_extension(normalized_mime.as_str()).to_string(),
        )
    };
    let audio_len = payload.len();

    append_log(
        &state.config.log_file_path,
        format!(
            "stt:file start mimeRaw={} mimeNormalized={} extension={} bytes={}",
            truncate_for_log(mime_type, 120),
            payload_mime,
            extension,
            audio_len
        ),
    );

    let part = Part::bytes(payload)
        .file_name(format!("speech.{extension}"))
        .mime_str(payload_mime.as_str())
        .map_err(|error| error.to_string())?;
    let mut form = Form::new()
        .part("file", part)
        .text("model", state.config.openai_stt_model.clone());
    if let Some(language) = resolve_transcription_language(locale) {
        form = form.text("language", language);
    }

    let response = state
        .client
        .post("https://api.openai.com/v1/audio/transcriptions")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;

    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The transcription request failed.")
            .to_string();
        append_log(
            &state.config.log_file_path,
            format!(
                "stt:file failed status={} mime={} bytes={}",
                status.as_u16(),
                payload_mime,
                audio_len
            ),
        );
        return Err(message);
    }

    Ok(value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn emit_transcription_stream_event(
    window: &WebviewWindow,
    context_id: &str,
    event: TranscriptionStreamEvent,
) -> Result<(), String> {
    let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
    window
        .emit(
            TRANSCRIPTION_STREAM_EVENT,
            context_bound_payload(context_id, payload),
        )
        .map_err(|error| error.to_string())
}

fn emit_transcription_provider_changed(
    window: &WebviewWindow,
    provider: TranscriptionProviderId,
) -> Result<(), String> {
    window
        .emit(
            TRANSCRIPTION_PROVIDER_CHANGED_EVENT,
            TranscriptionProviderChangedEvent {
                provider: transcription_provider_label(provider).to_string(),
            },
        )
        .map_err(|error| error.to_string())
}

async fn transcribe_with_openai_realtime(
    window: &WebviewWindow,
    state: &AppState,
    guard: &TenantExecutionGuard,
    session_id: &str,
    audio: &[u8],
    locale: Option<&str>,
) -> Result<String, String> {
    guard.ensure_current().await?;
    let api_key = state
        .config
        .openai_api_key
        .clone()
        .ok_or_else(|| "OPENAI_API_KEY is missing.".to_string())?;
    if audio.is_empty() {
        return Err("No audio available for transcription.".to_string());
    }

    let mut request = "wss://api.openai.com/v1/realtime?intent=transcription"
        .into_client_request()
        .map_err(|error| error.to_string())?;
    let auth_header = format!("Bearer {api_key}")
        .parse()
        .map_err(|error| format!("invalid auth header: {error}"))?;
    let beta_header = "realtime=v1"
        .parse()
        .map_err(|error| format!("invalid realtime header: {error}"))?;
    request.headers_mut().insert("Authorization", auth_header);
    request.headers_mut().insert("OpenAI-Beta", beta_header);

    append_log(
        &state.config.log_file_path,
        format!("stt:realtime connect bytes={}", audio.len()),
    );

    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| error.to_string())?;

    let language = resolve_transcription_language(locale);
    let setup_event = json!({
      "type": "transcription_session.update",
      "input_audio_format": "pcm16",
      "input_audio_transcription": {
        "model": state.config.openai_realtime_stt_model,
        "language": language,
      },
      "turn_detection": null,
      "input_audio_noise_reduction": {
        "type": "near_field"
      }
    });
    socket
        .send(WsMessage::Text(setup_event.to_string().into()))
        .await
        .map_err(|error| error.to_string())?;

    for chunk in audio.chunks(TRANSCRIPTION_CHUNK_BYTES) {
        let append_event = json!({
          "type": "input_audio_buffer.append",
          "audio": BASE64.encode(chunk),
        });
        socket
            .send(WsMessage::Text(append_event.to_string().into()))
            .await
            .map_err(|error| error.to_string())?;
    }
    socket
        .send(WsMessage::Text(
            json!({ "type": "input_audio_buffer.commit" })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| error.to_string())?;

    let mut transcript = String::new();
    let mut saw_completed = false;
    loop {
        guard.ensure_current().await?;
        let next = tokio::time::timeout(
            Duration::from_secs(TRANSCRIPTION_READ_TIMEOUT_SECS),
            socket.next(),
        )
        .await
        .map_err(|_| "Realtime transcription timeout.".to_string())?;
        let Some(frame) = next else {
            break;
        };
        let frame = frame.map_err(|error| error.to_string())?;
        let payload_text = match frame {
            WsMessage::Text(value) => value.to_string(),
            WsMessage::Binary(value) => String::from_utf8_lossy(&value).to_string(),
            WsMessage::Close(_) => break,
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            _ => continue,
        };

        let value = match serde_json::from_str::<Value>(payload_text.as_str()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match event_type {
            "input_audio_buffer.speech_started" => {
                let _ = emit_transcription_stream_event(
                    window,
                    &guard.session.context_id,
                    TranscriptionStreamEvent::SpeechStarted {
                        session_id: session_id.to_string(),
                        provider: transcription_provider_label(
                            TranscriptionProviderId::OpenAiRealtime,
                        )
                        .to_string(),
                    },
                );
            }
            "input_audio_buffer.speech_stopped" => {
                let _ = emit_transcription_stream_event(
                    window,
                    &guard.session.context_id,
                    TranscriptionStreamEvent::SpeechStopped {
                        session_id: session_id.to_string(),
                        provider: transcription_provider_label(
                            TranscriptionProviderId::OpenAiRealtime,
                        )
                        .to_string(),
                    },
                );
            }
            "conversation.item.input_audio_transcription.delta" => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    if !delta.trim().is_empty() {
                        transcript.push_str(delta);
                        let _ = emit_transcription_stream_event(
                            window,
                            &guard.session.context_id,
                            TranscriptionStreamEvent::Partial {
                                session_id: session_id.to_string(),
                                text: transcript.trim().to_string(),
                                provider: transcription_provider_label(
                                    TranscriptionProviderId::OpenAiRealtime,
                                )
                                .to_string(),
                            },
                        );
                    }
                }
            }
            "conversation.item.input_audio_transcription.completed" => {
                let completed = value
                    .get("transcript")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default()
                    .to_string();
                if !completed.is_empty() {
                    transcript = completed;
                }
                saw_completed = true;
                break;
            }
            "conversation.item.input_audio_transcription.failed" => {
                let message = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Realtime transcription failed.")
                    .to_string();
                return Err(message);
            }
            "error" => {
                let message = value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Realtime session error.")
                    .to_string();
                return Err(message);
            }
            _ => {}
        }
    }

    if !saw_completed && transcript.trim().is_empty() {
        return Err("Realtime transcription returned no transcript.".to_string());
    }

    let _ = socket.send(WsMessage::Close(None)).await;
    guard.ensure_current().await?;
    Ok(transcript.trim().to_string())
}

#[tauri::command]
async fn transcription_provider_get(state: State<'_, AppState>) -> Result<String, String> {
    let provider = *state.transcription_provider.lock().await;
    Ok(transcription_provider_label(provider).to_string())
}

#[tauri::command]
async fn transcription_provider_set(
    window: WebviewWindow,
    state: State<'_, AppState>,
    provider: String,
) -> Result<String, String> {
    let parsed = TranscriptionProviderId::parse(provider.as_str())?;
    {
        let mut guard = state.transcription_provider.lock().await;
        *guard = parsed;
    }
    append_log(
        &state.config.log_file_path,
        format!(
            "stt: provider switched to {}",
            transcription_provider_label(parsed)
        ),
    );
    emit_transcription_provider_changed(&window, parsed)?;
    Ok(transcription_provider_label(parsed).to_string())
}

#[tauri::command]
async fn transcription_session_start(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TranscriptionSessionStartRequest,
    expected_context_id: String,
) -> Result<TranscriptionSessionStartResult, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let tenant_session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session_id = request.session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("sessionId is required.".to_string());
    }
    let provider_state = state.transcription_provider.clone();
    let sessions = state.transcription_sessions.clone();
    let cleanup_sessions = sessions.clone();
    let event_context_id = tenant_session.context_id.clone();
    let event_session_id = session_id.clone();
    let session_context_id = tenant_session.context_id.clone();
    let session_epoch = tenant_session.local_epoch;
    broker
        .run_if_current(&expected_context_id, || async move {
            let provider = *provider_state.lock().await;
            sessions.lock().await.insert(
                session_id.clone(),
                TranscriptionSession {
                    session_id: session_id.clone(),
                    context_id: session_context_id.clone(),
                    local_epoch: session_epoch,
                    provider,
                    locale: request.locale.clone(),
                    mime_type: "audio/webm".to_string(),
                    audio_bytes: Vec::new(),
                },
            );
            let emit_result = emit_transcription_stream_event(
                &window,
                &event_context_id,
                TranscriptionStreamEvent::SessionReady {
                    session_id: event_session_id.clone(),
                    provider: transcription_provider_label(provider).to_string(),
                },
            )
            .and_then(|_| {
                emit_transcription_stream_event(
                    &window,
                    &event_context_id,
                    TranscriptionStreamEvent::SpeechStarted {
                        session_id: event_session_id.clone(),
                        provider: transcription_provider_label(provider).to_string(),
                    },
                )
            });
            if let Err(error) = emit_result {
                let mut current = cleanup_sessions.lock().await;
                if current
                    .get(event_session_id.as_str())
                    .is_some_and(|session| {
                        session.context_id == event_context_id
                            && session.local_epoch == session_epoch
                    })
                {
                    current.remove(event_session_id.as_str());
                }
                return Err(AgentStudioApiError::local(
                    "TRANSCRIPTION_EVENT_FAILED",
                    error,
                ));
            }
            Ok(TranscriptionSessionStartResult {
                session_id: event_session_id,
                provider: transcription_provider_label(provider).to_string(),
            })
        })
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn transcription_session_append_audio(
    state: State<'_, AppState>,
    request: TranscriptionSessionAppendAudioRequest,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let tenant_session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let chunk = BASE64
        .decode(request.audio_base64.as_bytes())
        .map_err(|error| error.to_string())?;
    let normalized_mime = normalize_audio_mime_for_transcription(request.mime_type.as_str());
    let mut sessions = state.transcription_sessions.lock().await;
    let session = sessions
        .get_mut(request.session_id.as_str())
        .ok_or_else(|| "Transcription session not found.".to_string())?;
    if session.context_id != tenant_session.context_id
        || session.local_epoch != tenant_session.local_epoch
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    if session.mime_type != normalized_mime && !session.audio_bytes.is_empty() {
        return Err(
            "All chunks in one transcription session must use the same mime type.".to_string(),
        );
    }
    session.mime_type = normalized_mime;
    if session.audio_bytes.len() + chunk.len() > TRANSCRIPTION_MAX_AUDIO_BYTES {
        return Err(format!(
            "Audio payload exceeds {} bytes limit.",
            TRANSCRIPTION_MAX_AUDIO_BYTES
        ));
    }
    session.audio_bytes.extend_from_slice(chunk.as_slice());
    Ok(())
}

#[tauri::command]
async fn transcription_session_commit_turn(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: TranscriptionSessionCommitTurnRequest,
    expected_context_id: String,
) -> Result<String, String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let tenant_session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let execution_guard = TenantExecutionGuard {
        broker,
        session: tenant_session.clone(),
    };
    let fallback_provider = state.config.transcription_provider_fallback;
    let (session_id, selected_provider, locale, mime_type, audio) = {
        let mut sessions = state.transcription_sessions.lock().await;
        let session = sessions
            .get_mut(request.session_id.as_str())
            .ok_or_else(|| "Transcription session not found.".to_string())?;
        if session.context_id != tenant_session.context_id
            || session.local_epoch != tenant_session.local_epoch
        {
            return Err("DESKTOP_SESSION_CHANGED".to_string());
        }
        if session.audio_bytes.is_empty() {
            return Err("No audio received for this session.".to_string());
        }
        let snapshot = (
            session.session_id.clone(),
            session.provider,
            session.locale.clone(),
            session.mime_type.clone(),
            session.audio_bytes.clone(),
        );
        session.audio_bytes.clear();
        snapshot
    };
    emit_transcription_stream_event(
        &window,
        &tenant_session.context_id,
        TranscriptionStreamEvent::SpeechStopped {
            session_id: session_id.clone(),
            provider: transcription_provider_label(selected_provider).to_string(),
        },
    )?;

    let provider_chain = build_transcription_provider_chain(selected_provider, fallback_provider);
    let mut last_error: Option<String> = None;
    for (provider_index, provider) in provider_chain.iter().copied().enumerate() {
        execution_guard.ensure_current().await?;
        let fallback_used = provider_index > 0;
        let provider_label = transcription_provider_label(provider).to_string();
        append_log(
            &state.config.log_file_path,
            format!(
                "stt: session commit provider={} fallback={} mime={} bytes={}",
                provider_label,
                fallback_used,
                mime_type,
                audio.len()
            ),
        );
        let result = match provider {
            TranscriptionProviderId::OpenAiRealtime => {
                transcribe_with_openai_realtime(
                    &window,
                    state.inner(),
                    &execution_guard,
                    session_id.as_str(),
                    &audio,
                    locale.as_deref(),
                )
                .await
            }
            TranscriptionProviderId::OpenAiFileFallback => {
                transcribe_with_openai_file_api(
                    state.inner(),
                    &audio,
                    mime_type.as_str(),
                    locale.as_deref(),
                )
                .await
            }
        };

        match result {
            Ok(text) => {
                execution_guard.ensure_current().await?;
                let normalized = text.trim().to_string();
                emit_transcription_stream_event(
                    &window,
                    &tenant_session.context_id,
                    TranscriptionStreamEvent::Final {
                        session_id: session_id.clone(),
                        text: normalized.clone(),
                        provider: provider_label,
                        fallback_used,
                    },
                )?;
                return Ok(normalized);
            }
            Err(message) => {
                execution_guard.ensure_current().await?;
                last_error = Some(message.clone());
                let _ = emit_transcription_stream_event(
                    &window,
                    &tenant_session.context_id,
                    TranscriptionStreamEvent::Error {
                        session_id: session_id.clone(),
                        provider: provider_label,
                        message,
                    },
                );
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Transcription failed.".to_string()))
}

#[tauri::command]
async fn transcription_session_stop(
    state: State<'_, AppState>,
    request: TranscriptionSessionStopRequest,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let tenant_session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let mut sessions = state.transcription_sessions.lock().await;
    if sessions
        .get(request.session_id.as_str())
        .is_some_and(|session| {
            session.context_id != tenant_session.context_id
                || session.local_epoch != tenant_session.local_epoch
        })
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    sessions.remove(request.session_id.as_str());
    Ok(())
}

#[tauri::command]
async fn tts_list_voices(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let build_voice_list = |values: &[String]| {
        let mut voices = values.to_vec();
        voices.sort_unstable();
        voices.dedup();
        voices
    };

    match state.config.tts_provider {
        TtsProviderMode::Local => {
            if !state.config.local_tts_available() {
                return Err(
                    "LOCAL_TTS_URL is missing while TTS_PROVIDER=local is configured.".to_string(),
                );
            }
            Ok(build_voice_list(&state.config.local_tts_voices))
        }
        TtsProviderMode::FishAudio => {
            if !state.config.fish_tts_available() {
                return Err(
                    "LOCAL_TTS_URL is missing while TTS_PROVIDER=fish is configured.".to_string(),
                );
            }
            Ok(build_voice_list(&state.config.local_tts_voices))
        }
        TtsProviderMode::OpenAI => {
            if !state.config.openai_tts_available() {
                return Err(
                    "OPENAI_API_KEY is missing or OPENAI_TTS_ENABLED=false while TTS_PROVIDER=openai is configured."
                        .to_string(),
                );
            }
            Ok(build_voice_list(&state.config.openai_tts_voices))
        }
        TtsProviderMode::System => list_system_tts_voices().await,
        TtsProviderMode::Auto => {
            if state.config.local_tts_available() {
                return Ok(build_voice_list(&state.config.local_tts_voices));
            }
            if state.config.openai_tts_available() {
                return Ok(build_voice_list(&state.config.openai_tts_voices));
            }
            list_system_tts_voices().await
        }
    }
}

#[tauri::command]
async fn tts_speak(
    state: State<'_, AppState>,
    window: WebviewWindow,
    request_id: String,
    text: String,
    voice: Option<String>,
    expected_context_id: String,
) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let session = broker
        .require_current(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let execution_guard = TenantExecutionGuard { broker, session };
    let expected_tts_generation = state.tts_generation.load(Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let normalized_text = normalize_tts_text(&text);
        let scoped_request_id = format!("{}:{request_id}", execution_guard.session.context_id);
        let cache = state.last_tts_text_by_request.clone();
        let dedupe_broker = execution_guard.broker.clone();
        let should_skip = dedupe_broker
            .run_if_current(&expected_context_id, || async move {
                let mut cache = cache.lock().await;
                Ok(should_skip_duplicate_tts_entry(
                    &mut cache,
                    &scoped_request_id,
                    &normalized_text,
                ))
            })
            .await
            .map_err(|error| error.to_string())?;
        if should_skip {
            append_log(&state.config.log_file_path, "tts: duplicate suppressed");
            return Ok(());
        }

        let selected_voice = voice
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let provider_chain = match state.config.tts_provider {
            TtsProviderMode::Local => vec![TtsProviderMode::Local, TtsProviderMode::System],
            TtsProviderMode::FishAudio => {
                vec![TtsProviderMode::FishAudio, TtsProviderMode::System]
            }
            TtsProviderMode::OpenAI => vec![TtsProviderMode::OpenAI, TtsProviderMode::System],
            TtsProviderMode::System => vec![TtsProviderMode::System],
            TtsProviderMode::Auto => {
                let mut values = Vec::new();
                if state.config.local_tts_available() {
                    values.push(TtsProviderMode::Local);
                }
                if state.config.openai_tts_available() {
                    values.push(TtsProviderMode::OpenAI);
                }
                values.push(TtsProviderMode::System);
                values
            }
        };

        let mut last_error: Option<String> = None;
        for (provider_index, provider) in provider_chain.into_iter().enumerate() {
            execution_guard.ensure_current().await?;
            ensure_tts_generation(state.inner(), expected_tts_generation)?;
            let is_fallback = provider_index > 0;
            let provider_name = tts_provider_name(provider);
            let result = match provider {
                TtsProviderMode::Local => {
                    speak_local_tts(
                        state.inner(),
                        &execution_guard,
                        expected_tts_generation,
                        &window,
                        &request_id,
                        &text,
                        selected_voice.as_deref(),
                        is_fallback,
                    )
                    .await
                }
                TtsProviderMode::FishAudio => {
                    speak_fish_tts(
                        state.inner(),
                        &execution_guard,
                        expected_tts_generation,
                        &window,
                        &request_id,
                        &text,
                        selected_voice.as_deref(),
                        is_fallback,
                    )
                    .await
                }
                TtsProviderMode::OpenAI => {
                    speak_openai_tts(
                        state.inner(),
                        &execution_guard,
                        expected_tts_generation,
                        &window,
                        &request_id,
                        &text,
                        selected_voice.as_deref(),
                        is_fallback,
                    )
                    .await
                }
                TtsProviderMode::System => {
                    // Only apply a selected voice for explicit system mode; in fallback mode,
                    // let macOS choose a valid default voice.
                    let system_voice = if state.config.tts_provider == TtsProviderMode::System {
                        selected_voice.as_deref()
                    } else {
                        None
                    };
                    speak_system_tts(
                        state.inner(),
                        &window,
                        &execution_guard,
                        expected_tts_generation,
                        &request_id,
                        &text,
                        system_voice,
                        provider_name,
                        is_fallback,
                    )
                    .await
                }
                TtsProviderMode::Auto => unreachable!(),
            };

            if result.is_ok() {
                append_log(
                    &state.config.log_file_path,
                    format!("tts: provider={provider_name} selected fallback={is_fallback}"),
                );
                return Ok(());
            }

            let message = result
                .err()
                .unwrap_or_else(|| "Unknown TTS provider error.".to_string());
            append_log(
                &state.config.log_file_path,
                format!("tts: provider={provider:?} failed"),
            );
            last_error = Some(message);
        }

        Err(last_error.unwrap_or_else(|| "No TTS provider available.".to_string()))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        let _ = text;
        let _ = voice;
        execution_guard.ensure_current().await?;
        emit_tts_state(
            &window,
            &execution_guard.session.context_id,
            &request_id,
            false,
            None,
            None,
        )?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
async fn list_system_tts_voices() -> Result<Vec<String>, String> {
    let output = Command::new("say")
        .arg("-v")
        .arg("?")
        .output()
        .await
        .map_err(|error| error.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "Failed to list TTS voices (exit {}): {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let mut voices: Vec<String> = stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.split_whitespace().next().map(str::to_string)
        })
        .collect();
    voices.sort_unstable();
    voices.dedup();
    Ok(voices)
}

#[cfg(not(target_os = "macos"))]
async fn list_system_tts_voices() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
fn ensure_tts_generation(state: &AppState, expected_generation: u64) -> Result<(), String> {
    if state.tts_generation.load(Ordering::SeqCst) == expected_generation {
        Ok(())
    } else {
        Err("DESKTOP_SESSION_CHANGED".to_string())
    }
}

#[cfg(target_os = "macos")]
async fn spawn_tenant_tts_process(
    state: &AppState,
    window: &WebviewWindow,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    request_id: &str,
    provider_name: &str,
    fallback_used: bool,
    mut command: Command,
    temp_path: Option<PathBuf>,
) -> Result<(), String> {
    command.kill_on_drop(true);
    let broker = guard.broker.clone();
    let context_id = guard.session.context_id.clone();
    let event_context_id = context_id.clone();
    let process_id = uuid::Uuid::new_v4().to_string();
    let processes = state.tts_processes.clone();
    let generation = state.tts_generation.clone();
    let waiter_guard = guard.clone();
    let window = window.clone();
    let request_id = request_id.to_string();
    let provider_name = provider_name.to_string();

    broker
        .run_if_current(&context_id, || async move {
            if generation.load(Ordering::SeqCst) != expected_generation {
                if let Some(path) = &temp_path {
                    let _ = fs::remove_file(path);
                }
                return Err(AgentStudioApiError::local(
                    "DESKTOP_SESSION_CHANGED",
                    "The Agent Studio session changed.",
                ));
            }

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    if let Some(path) = &temp_path {
                        let _ = fs::remove_file(path);
                    }
                    return Err(AgentStudioApiError::local(
                        "TTS_PROCESS_FAILED",
                        error.to_string(),
                    ));
                }
            };
            if let Err(error) = emit_tts_state(
                &window,
                &event_context_id,
                &request_id,
                true,
                Some(&provider_name),
                Some(fallback_used),
            ) {
                let _ = child.kill().await;
                let _ = child.wait().await;
                if let Some(path) = &temp_path {
                    let _ = fs::remove_file(path);
                }
                return Err(AgentStudioApiError::local("TTS_PROCESS_FAILED", error));
            }

            let (cancel_tx, cancel_rx) = oneshot::channel();
            let (stopped_tx, stopped_rx) = oneshot::channel();
            processes.lock().await.insert(
                process_id.clone(),
                TtsProcessHandle {
                    cancel: cancel_tx,
                    stopped: stopped_rx,
                },
            );

            let waiter_processes = processes.clone();
            let waiter_process_id = process_id.clone();
            async_runtime::spawn(async move {
                let cancelled = tokio::select! {
                    _ = child.wait() => false,
                    _ = cancel_rx => {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        true
                    }
                };
                if let Some(path) = temp_path {
                    let _ = fs::remove_file(path);
                }
                waiter_processes.lock().await.remove(&waiter_process_id);
                if !cancelled
                    && generation.load(Ordering::SeqCst) == expected_generation
                    && waiter_guard.ensure_current().await.is_ok()
                {
                    let _ = emit_tts_state(
                        &window,
                        &waiter_guard.session.context_id,
                        &request_id,
                        false,
                        Some(&provider_name),
                        Some(fallback_used),
                    );
                }
                let _ = stopped_tx.send(());
            });
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
async fn speak_system_tts(
    state: &AppState,
    window: &WebviewWindow,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    request_id: &str,
    text: &str,
    voice: Option<&str>,
    provider_name: &str,
    fallback_used: bool,
) -> Result<(), String> {
    let mut command = Command::new("say");
    if let Some(selected_voice) = voice {
        command.arg("-v").arg(selected_voice);
    }
    command.arg("-r").arg("185").arg(text);
    spawn_tenant_tts_process(
        state,
        window,
        guard,
        expected_generation,
        request_id,
        provider_name,
        fallback_used,
        command,
        None,
    )
    .await
}

#[cfg(target_os = "macos")]
async fn speak_local_tts(
    state: &AppState,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    window: &WebviewWindow,
    request_id: &str,
    text: &str,
    voice: Option<&str>,
    fallback_used: bool,
) -> Result<(), String> {
    let raw_endpoint = state
        .config
        .local_tts_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCAL_TTS_URL is missing.".to_string())?;

    let endpoints = local_tts_endpoint_candidates(raw_endpoint);
    if endpoints.is_empty() {
        return Err("LOCAL_TTS_URL resolved to no usable endpoint.".to_string());
    }

    let mut last_error: Option<String> = None;
    for endpoint in endpoints {
        append_log(&state.config.log_file_path, "tts: provider=local attempt");
        match speak_http_tts(
            state,
            guard,
            expected_generation,
            window,
            request_id,
            text,
            voice,
            endpoint.as_str(),
            state.config.local_tts_api_key.as_deref(),
            state.config.local_tts_model.as_str(),
            state.config.local_tts_default_voice.as_str(),
            &state.config.local_tts_request_template,
            state.config.local_tts_response_base64_path.as_deref(),
            Some(&state.config.local_tts_headers),
            "local",
            fallback_used,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                append_log(
                    &state.config.log_file_path,
                    "tts: provider=local endpoint failed",
                );
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "local TTS failed for all endpoint candidates.".to_string()))
}

#[cfg(target_os = "macos")]
async fn speak_fish_tts(
    state: &AppState,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    window: &WebviewWindow,
    request_id: &str,
    text: &str,
    voice: Option<&str>,
    fallback_used: bool,
) -> Result<(), String> {
    let raw_endpoint = state
        .config
        .local_tts_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LOCAL_TTS_URL is missing.".to_string())?;

    let endpoints = local_tts_endpoint_candidates(raw_endpoint);
    if endpoints.is_empty() {
        return Err("LOCAL_TTS_URL resolved to no usable endpoint.".to_string());
    }

    let mut last_error: Option<String> = None;
    for endpoint in endpoints {
        append_log(&state.config.log_file_path, "tts: provider=fish attempt");
        match speak_http_tts(
            state,
            guard,
            expected_generation,
            window,
            request_id,
            text,
            voice,
            endpoint.as_str(),
            state.config.local_tts_api_key.as_deref(),
            state.config.local_tts_model.as_str(),
            state.config.local_tts_default_voice.as_str(),
            &state.config.local_tts_request_template,
            state.config.local_tts_response_base64_path.as_deref(),
            Some(&state.config.local_tts_headers),
            "fish",
            fallback_used,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(error) => {
                append_log(
                    &state.config.log_file_path,
                    "tts: provider=fish endpoint failed",
                );
                last_error = Some(error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "fish TTS failed for all endpoint candidates.".to_string()))
}

#[cfg(target_os = "macos")]
async fn speak_openai_tts(
    state: &AppState,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    window: &WebviewWindow,
    request_id: &str,
    text: &str,
    voice: Option<&str>,
    fallback_used: bool,
) -> Result<(), String> {
    let api_key = state
        .config
        .openai_api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "OPENAI_API_KEY is missing.".to_string())?;

    let openai_request_template =
        default_local_tts_request_template(TtsHttpRequestFormat::OpenAiCompat);

    speak_http_tts(
        state,
        guard,
        expected_generation,
        window,
        request_id,
        text,
        voice,
        "https://api.openai.com/v1/audio/speech",
        Some(api_key),
        state.config.openai_tts_model.as_str(),
        state.config.openai_tts_default_voice.as_str(),
        &openai_request_template,
        None,
        None,
        "openai",
        fallback_used,
    )
    .await
}

#[cfg(target_os = "macos")]
async fn speak_http_tts(
    state: &AppState,
    guard: &TenantExecutionGuard,
    expected_generation: u64,
    window: &WebviewWindow,
    request_id: &str,
    text: &str,
    voice: Option<&str>,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    default_voice: &str,
    request_template: &Value,
    response_base64_path: Option<&str>,
    extra_headers: Option<&HashMap<String, String>>,
    provider_name: &str,
    fallback_used: bool,
) -> Result<(), String> {
    guard.ensure_current().await?;
    ensure_tts_generation(state, expected_generation)?;
    let selected_voice = voice
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_voice);

    let mut request = state
        .client
        .post(endpoint)
        .header(CONTENT_TYPE, "application/json");
    if let Some(bearer) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        request = request.header(AUTHORIZATION, format!("Bearer {bearer}"));
    }
    if let Some(headers) = extra_headers {
        for (name, value) in headers {
            let normalized_name = name.trim();
            let normalized_value = value.trim();
            if normalized_name.is_empty() || normalized_value.is_empty() {
                continue;
            }
            request = request.header(normalized_name, normalized_value);
        }
    }
    let payload = render_tts_request_template(request_template, text, selected_voice, model);
    append_log(
        &state.config.log_file_path,
        format!(
            "tts:http start provider={provider_name} fallback={fallback_used} chars={}",
            text.chars().count(),
        ),
    );
    let response = request.json(&payload).send().await.map_err(|error| {
        let message = error.to_string();
        append_log(
            &state.config.log_file_path,
            format!("tts:http transport-error provider={provider_name}"),
        );
        message
    })?;

    let status = response.status();
    let response_content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    guard.ensure_current().await?;
    ensure_tts_generation(state, expected_generation)?;
    append_log(
        &state.config.log_file_path,
        format!(
            "tts:http response provider={provider_name} status={} contentType={} bytes={}",
            status.as_u16(),
            response_content_type.as_deref().unwrap_or("<none>"),
            body.len()
        ),
    );

    if !status.is_success() {
        append_log(
            &state.config.log_file_path,
            format!(
                "tts:http non-success provider={provider_name} status={}",
                status.as_u16()
            ),
        );
        return Err(format!(
            "{provider_name} TTS request failed with status {status}."
        ));
    }

    let looks_like_json = body
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace())
        .map(|byte| byte == b'{' || byte == b'[')
        .unwrap_or(false);
    let is_json_content_type = response_content_type
        .as_deref()
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .map(|value| value == "application/json" || value.ends_with("+json"))
        .unwrap_or(false);

    let bytes = if is_json_content_type || looks_like_json {
        decode_json_tts_audio(&body, provider_name, response_base64_path)?
    } else {
        body
    };
    if bytes.is_empty() {
        return Err(format!(
            "{provider_name} TTS returned an empty audio payload."
        ));
    }
    guard.ensure_current().await?;

    let extension = if is_json_content_type || looks_like_json {
        "mp3"
    } else {
        audio_file_extension_from_content_type(response_content_type.as_deref())
    };
    let temp_path = env::temp_dir().join(format!(
        "desktop-avatar-tts-{}.{extension}",
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;

    if let Err(error) = guard.ensure_current().await {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    if let Err(error) = ensure_tts_generation(state, expected_generation) {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    let mut command = Command::new("afplay");
    command.arg(&temp_path);
    spawn_tenant_tts_process(
        state,
        window,
        guard,
        expected_generation,
        request_id,
        provider_name,
        fallback_used,
        command,
        Some(temp_path),
    )
    .await
}

#[tauri::command]
async fn tts_stop(state: State<'_, AppState>, expected_context_id: String) -> Result<(), String> {
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    broker
        .run_if_current(&expected_context_id, || async {
            state.tts_generation.fetch_add(1, Ordering::SeqCst);
            cancel_tts_processes(state.inner()).await;
            cleanup_tts_temp_files();
            Ok(())
        })
        .await
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum WindowResizeAnchor {
    Left,
    Right,
}

fn resize_window_internal(
    window: &WebviewWindow,
    width: f64,
    height: f64,
    anchor: WindowResizeAnchor,
) -> Result<(), String> {
    let current = current_window_rect(window)?;
    let target_x = match anchor {
        WindowResizeAnchor::Left => current.x,
        // Keep right edge fixed when opening/closing left-side widget docks.
        WindowResizeAnchor::Right => current.x + current.width - width,
    };
    let target_rect = WindowRect {
        x: target_x,
        y: current.y,
        width,
        height,
    };
    let clamped = clamp_window_rect_to_monitor(window, target_rect)?;
    apply_window_rect(window, clamped)
}

async fn process_desktop_avatar_stream(
    window: WebviewWindow,
    _request_id: String,
    response: reqwest::Response,
    broker: Arc<AgentStudioSessionBroker>,
    session: DesktopAvatarTenantSession,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("SYNTRA Assistant stream returned {status}."));
    }

    let mut parser = SseParser {
        current: SseFrame::new(),
    };
    let mut pending = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        pending.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(index) = pending.find('\n') {
            let mut line = pending[..index].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            pending.replace_range(..=index, "");
            if let Some(frame) = parser.push_line(line.as_str()) {
                let payload: Value = serde_json::from_str(frame.data().as_str())
                    .map_err(|error| error.to_string())?;
                ensure_stream_current(&broker, &session).await?;
                emit_desktop_avatar_stream_event(&window, &session.context_id, payload)?;
            }
        }
    }

    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        if let Some(frame) = parser.push_line(line.as_str()) {
            let payload: Value =
                serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
            ensure_stream_current(&broker, &session).await?;
            emit_desktop_avatar_stream_event(&window, &session.context_id, payload)?;
        }
    }

    if let Some(frame) = parser.finish() {
        let payload: Value =
            serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
        ensure_stream_current(&broker, &session).await?;
        emit_desktop_avatar_stream_event(&window, &session.context_id, payload)?;
    }

    Ok(())
}

async fn process_hitl_decision_stream(
    window: WebviewWindow,
    response: reqwest::Response,
    broker: Arc<AgentStudioSessionBroker>,
    session: DesktopAvatarTenantSession,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HITL stream returned {status}."));
    }

    let mut parser = SseParser {
        current: SseFrame::new(),
    };
    let mut pending = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        pending.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(index) = pending.find('\n') {
            let mut line = pending[..index].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            pending.replace_range(..=index, "");
            if let Some(frame) = parser.push_line(line.as_str()) {
                let payload: Value = serde_json::from_str(frame.data().as_str())
                    .map_err(|error| error.to_string())?;
                ensure_stream_current(&broker, &session).await?;
                emit_hitl_decision_stream_event(&window, &session.context_id, payload)?;
            }
        }
    }

    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        if let Some(frame) = parser.push_line(line.as_str()) {
            let payload: Value =
                serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
            ensure_stream_current(&broker, &session).await?;
            emit_hitl_decision_stream_event(&window, &session.context_id, payload)?;
        }
    }

    if let Some(frame) = parser.finish() {
        let payload: Value =
            serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
        ensure_stream_current(&broker, &session).await?;
        emit_hitl_decision_stream_event(&window, &session.context_id, payload)?;
    }

    Ok(())
}

async fn process_desktop_avatar_radar_stream(
    window: WebviewWindow,
    response: reqwest::Response,
    broker: Arc<AgentStudioSessionBroker>,
    session: DesktopAvatarTenantSession,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Operator-Radar stream returned {status}."));
    }

    let mut parser = SseParser {
        current: SseFrame::new(),
    };
    let mut pending = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        pending.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(index) = pending.find('\n') {
            let mut line = pending[..index].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            pending.replace_range(..=index, "");
            if let Some(frame) = parser.push_line(line.as_str()) {
                let payload: Value = serde_json::from_str(frame.data().as_str())
                    .map_err(|error| error.to_string())?;
                ensure_stream_current(&broker, &session).await?;
                emit_desktop_avatar_radar_stream_event(&window, &session.context_id, payload)?;
            }
        }
    }

    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        if let Some(frame) = parser.push_line(line.as_str()) {
            let payload: Value =
                serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
            ensure_stream_current(&broker, &session).await?;
            emit_desktop_avatar_radar_stream_event(&window, &session.context_id, payload)?;
        }
    }

    if let Some(frame) = parser.finish() {
        let payload: Value =
            serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
        ensure_stream_current(&broker, &session).await?;
        emit_desktop_avatar_radar_stream_event(&window, &session.context_id, payload)?;
    }

    Ok(())
}

async fn ensure_stream_current(
    broker: &AgentStudioSessionBroker,
    session: &DesktopAvatarTenantSession,
) -> Result<(), String> {
    if broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        Ok(())
    } else {
        Err("DESKTOP_SESSION_CHANGED".to_string())
    }
}

fn context_bound_payload(context_id: &str, mut payload: Value) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert(
            "contextId".to_string(),
            Value::String(context_id.to_string()),
        );
        payload
    } else {
        json!({ "contextId": context_id, "payload": payload })
    }
}

fn emit_desktop_avatar_stream_event(
    window: &WebviewWindow,
    context_id: &str,
    payload: Value,
) -> Result<(), String> {
    window
        .emit(
            DESKTOP_AVATAR_STREAM_EVENT,
            context_bound_payload(context_id, payload),
        )
        .map_err(|error| error.to_string())
}

fn emit_desktop_avatar_stream_lifecycle(
    window: &WebviewWindow,
    context_id: &str,
    avatar_request_id: &str,
    phase: &str,
    reason: Option<String>,
) -> Result<(), String> {
    window
        .emit(
            DESKTOP_AVATAR_STREAM_LIFECYCLE_EVENT,
            DesktopAvatarStreamLifecycleEvent {
                context_id: context_id.to_string(),
                avatar_request_id: avatar_request_id.to_string(),
                phase: phase.to_string(),
                reason,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_hitl_decision_stream_event(
    window: &WebviewWindow,
    context_id: &str,
    payload: Value,
) -> Result<(), String> {
    window
        .emit(
            HITL_DECISION_STREAM_EVENT,
            context_bound_payload(context_id, payload),
        )
        .map_err(|error| error.to_string())
}

fn emit_desktop_avatar_radar_stream_event(
    window: &WebviewWindow,
    context_id: &str,
    payload: Value,
) -> Result<(), String> {
    window
        .emit(
            DESKTOP_AVATAR_RADAR_STREAM_EVENT,
            context_bound_payload(context_id, payload),
        )
        .map_err(|error| error.to_string())
}

fn emit_desktop_avatar_radar_stream_lifecycle(
    window: &WebviewWindow,
    context_id: &str,
    phase: &str,
    reason: Option<String>,
) -> Result<(), String> {
    window
        .emit(
            DESKTOP_AVATAR_RADAR_STREAM_LIFECYCLE_EVENT,
            DesktopAvatarRadarStreamLifecycleEvent {
                context_id: context_id.to_string(),
                phase: phase.to_string(),
                reason,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_hitl_decision_stream_lifecycle(
    window: &WebviewWindow,
    context_id: &str,
    phase: &str,
    reason: Option<String>,
) -> Result<(), String> {
    window
        .emit(
            HITL_DECISION_STREAM_LIFECYCLE_EVENT,
            HitlDecisionStreamLifecycleEvent {
                context_id: context_id.to_string(),
                phase: phase.to_string(),
                reason,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_tts_state(
    window: &WebviewWindow,
    context_id: &str,
    request_id: &str,
    speaking: bool,
    provider: Option<&str>,
    fallback: Option<bool>,
) -> Result<(), String> {
    window
        .emit(
            TTS_STATE_EVENT,
            TtsStateEvent {
                context_id: context_id.to_string(),
                request_id: request_id.to_string(),
                speaking,
                provider: provider.map(str::to_string),
                fallback,
            },
        )
        .map_err(|error| error.to_string())
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn append_log(path: &Path, message: impl AsRef<str>) {
    #[cfg(not(debug_assertions))]
    {
        let _ = path;
        let _ = message;
        return;
    }

    #[cfg(debug_assertions)]
    {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();

        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        options.mode(0o600);
        if let Ok(mut file) = options.open(path) {
            #[cfg(unix)]
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
            let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
        }
    }
}

fn reset_log_file(path: &Path) {
    #[cfg(not(debug_assertions))]
    {
        let _ = path;
        return;
    }

    #[cfg(debug_assertions)]
    {
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        if let Ok(file) = options.open(path) {
            #[cfg(unix)]
            let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
        }
    }
}

fn is_remote_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn resolve_manifest_asset_path(path: &str, base_dir: &Path) -> String {
    if is_remote_url(path) || Path::new(path).is_absolute() {
        return path.to_string();
    }

    base_dir.join(path).to_string_lossy().into_owned()
}

fn resolve_avatar_manifest_paths(manifest: &mut AvatarManifest, base_dir: &Path) {
    manifest.model_url = manifest
        .model_url
        .as_ref()
        .map(|path| resolve_manifest_asset_path(path, base_dir));
    manifest.vrm_url = manifest
        .vrm_url
        .as_ref()
        .map(|path| resolve_manifest_asset_path(path, base_dir));
    manifest.idle_animation_urls = manifest
        .idle_animation_urls
        .iter()
        .map(|path| resolve_manifest_asset_path(path, base_dir))
        .collect();
    manifest.attention_animation_url = manifest
        .attention_animation_url
        .as_ref()
        .map(|path| resolve_manifest_asset_path(path, base_dir));
    manifest.thinking_animation_url = manifest
        .thinking_animation_url
        .as_ref()
        .map(|path| resolve_manifest_asset_path(path, base_dir));
    manifest.talking_animation_url = manifest
        .talking_animation_url
        .as_ref()
        .map(|path| resolve_manifest_asset_path(path, base_dir));
}

async fn load_remote_avatar_asset(path: String) -> Result<AssetPayload, String> {
    let response = Client::new()
        .get(&path)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let response = response
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| mime_type_for_path(&path));
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;

    Ok(AssetPayload {
        mime_type,
        base64: BASE64.encode(bytes),
    })
}

fn mime_type_for_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "vrm" => "model/gltf-binary".to_string(),
        "vrma" | "glb" => "model/gltf-binary".to_string(),
        "gltf" => "model/gltf+json".to_string(),
        "fbx" => "application/octet-stream".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn mime_extension(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "audio/pcm" | "audio/l16" => "wav",
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => "m4a",
        "audio/webm" => "webm",
        "audio/mpeg" | "audio/mp3" | "audio/mpga" => "mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        _ => "webm",
    }
}

fn normalize_audio_mime_for_transcription(mime: &str) -> String {
    let normalized = mime
        .split(';')
        .next()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match normalized.as_str() {
        "audio/pcm" | "audio/l16" => "audio/pcm".to_string(),
        "audio/mp4" | "audio/x-m4a" | "audio/m4a" => "audio/mp4".to_string(),
        "audio/webm" => "audio/webm".to_string(),
        "audio/mpeg" | "audio/mp3" | "audio/mpga" => "audio/mpeg".to_string(),
        "audio/wav" | "audio/x-wav" | "audio/wave" => "audio/wav".to_string(),
        "audio/ogg" => "audio/ogg".to_string(),
        "audio/flac" => "audio/flac".to_string(),
        _ => {
            if normalized.starts_with("audio/") {
                normalized
            } else {
                "audio/webm".to_string()
            }
        }
    }
}

fn audio_file_extension_from_content_type(content_type: Option<&str>) -> &'static str {
    let normalized = content_type
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match normalized.as_str() {
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        _ => "mp3",
    }
}

fn normalize_language_code(value: &str) -> Option<String> {
    let normalized = value
        .split('.')
        .next()
        .unwrap_or(value)
        .split('@')
        .next()
        .unwrap_or(value)
        .split(['-', '_'])
        .next()
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase();

    if normalized.is_empty() || normalized == "c" || normalized == "posix" {
        return None;
    }

    if normalized.len() < 2 || normalized.len() > 3 {
        return None;
    }

    if !normalized.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return None;
    }

    Some(normalized)
}

fn resolve_transcription_language(request_locale: Option<&str>) -> Option<String> {
    request_locale
        .and_then(normalize_language_code)
        .or_else(|| {
            env::var("LANG")
                .ok()
                .and_then(|value| normalize_language_code(&value))
        })
        .or_else(|| Some("de".to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bootstrap_config = AppConfig::load();
    let agent_studio = bootstrap_config
        .comm_officer_base_url
        .as_deref()
        .ok_or_else(|| {
            AgentStudioApiError::local("AUTH_NOT_CONFIGURED", "COMM_OFFICER_BASE_URL is required.")
        })
        .and_then(|base_url| {
            AgentStudioApiClient::new(
                base_url,
                bootstrap_config.comm_officer_csrf_cookie_name.as_deref(),
            )
        })
        .map(AgentStudioSessionBroker::new)
        .map(Arc::new);
    let default_transcription_provider = bootstrap_config.transcription_provider_default;
    let mut persisted_window_state =
        read_persisted_window_state(&bootstrap_config.window_state_path);
    let normalized_peek_size = normalize_peek_size(
        persisted_window_state.peek_size.width,
        persisted_window_state.peek_size.height,
    );
    persisted_window_state.peek_size = normalized_peek_size;
    persisted_window_state.last_peek_rect =
        persisted_window_state
            .last_peek_rect
            .map(|rect| WindowRect {
                width: normalized_peek_size.width,
                height: normalized_peek_size.height,
                ..rect
            });
    let state = AppState {
        client: Client::new(),
        config: Arc::new(bootstrap_config),
        agent_studio,
        desktop_avatar_streams: Arc::new(Mutex::new(HashMap::new())),
        desktop_avatar_radar_stream: Arc::new(Mutex::new(None)),
        hitl_decision_stream: Arc::new(Mutex::new(None)),
        last_tts_text_by_request: Arc::new(Mutex::new(HashMap::new())),
        tts_generation: Arc::new(AtomicU64::new(0)),
        tts_processes: Arc::new(Mutex::new(HashMap::new())),
        shutdown_started: Arc::new(AtomicBool::new(false)),
        peek_position: Arc::new(Mutex::new(persisted_window_state.peek_position)),
        current_window_mode: Arc::new(Mutex::new(WindowMode::default())),
        last_peek_rect: Arc::new(Mutex::new(persisted_window_state.last_peek_rect)),
        last_expanded_rect: Arc::new(Mutex::new(persisted_window_state.last_expanded_rect)),
        suppress_window_tracking: Arc::new(Mutex::new(false)),
        drag_tracking_mode: Arc::new(Mutex::new(None)),
        drag_tracking_revision: Arc::new(Mutex::new(0)),
        peek_size: Arc::new(Mutex::new(persisted_window_state.peek_size)),
        transcription_provider: Arc::new(Mutex::new(default_transcription_provider)),
        transcription_sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    let provider_label = tts_provider_name(state.config.tts_provider);
    append_log(
        &state.config.log_file_path,
        format!(
            "tts: config provider={provider_label} localConfigured={} openaiEnabled={}",
            state.config.local_tts_available(),
            state.config.openai_tts_available()
        ),
    );

    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            auth_preauthenticate,
            auth_companies,
            auth_branches,
            auth_complete,
            auth_session_get,
            auth_logout,
            load_bootstrap_state,
            load_avatar_asset,
            frontend_log,
            window_set_peek_mode,
            window_set_peek_position,
            window_resize,
            window_get_geometry,
            window_start_drag,
            desktop_avatar_request_create,
            desktop_avatar_request_get,
            desktop_avatar_radar_get,
            desktop_avatar_radar_stream_start,
            desktop_avatar_radar_stream_stop,
            desktop_avatar_request_stream,
            desktop_avatar_request_stream_stop,
            hitl_decision_stream_start,
            hitl_decision_stream_stop,
            hitl_decision_approve,
            hitl_decision_reject,
            hitl_request_more_info,
            speech_transcribe,
            transcription_provider_get,
            transcription_provider_set,
            transcription_session_start,
            transcription_session_append_audio,
            transcription_session_commit_turn,
            transcription_session_stop,
            tts_list_voices,
            tts_speak,
            tts_stop
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_always_on_top(true);
            let initial_peek_rect = startup_peek_origin(&persisted_window_state)
                .map(|(x, y)| peek_rect_for_origin(&window, x, y, normalized_peek_size))
                .unwrap_or_else(|| {
                    peek_rect_for_position(
                        &window,
                        persisted_window_state.peek_position,
                        normalized_peek_size,
                    )
                });
            if let Ok(rect) = initial_peek_rect {
                let _ = apply_window_rect(&window, rect);
            }
            let drag_tracking_mode_state = app.state::<AppState>().drag_tracking_mode.clone();
            let drag_tracking_revision_state =
                app.state::<AppState>().drag_tracking_revision.clone();
            let suppress_window_tracking_state =
                app.state::<AppState>().suppress_window_tracking.clone();
            let app_state = app.state::<AppState>().inner().clone();
            let tracked_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                ) {
                    let app_state = app_state.clone();
                    let tracked_window = tracked_window.clone();
                    async_runtime::spawn(async move {
                        let Ok(rect) = current_window_rect(&tracked_window) else {
                            return;
                        };
                        let mode = *app_state.current_window_mode.lock().await;
                        match mode {
                            WindowMode::Peek => {
                                let peek_size = *app_state.peek_size.lock().await;
                                let mut guard = app_state.last_peek_rect.lock().await;
                                *guard = peek_rect_for_origin(
                                    &tracked_window,
                                    rect.x,
                                    rect.y,
                                    peek_size,
                                )
                                .ok();
                            }
                            WindowMode::Expanded => {
                                let mut guard = app_state.last_expanded_rect.lock().await;
                                *guard = clamp_window_rect_to_monitor(&tracked_window, rect).ok();
                            }
                        }
                        persist_window_state(&app_state).await;
                    });
                    return;
                }

                if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                    return;
                }
                let drag_tracking_mode_state = drag_tracking_mode_state.clone();
                let drag_tracking_revision_state = drag_tracking_revision_state.clone();
                let suppress_window_tracking_state = suppress_window_tracking_state.clone();
                let app_state = app_state.clone();
                let tracked_window = tracked_window.clone();
                async_runtime::spawn(async move {
                    if *suppress_window_tracking_state.lock().await {
                        return;
                    }
                    let active_mode = *drag_tracking_mode_state.lock().await;
                    let Some(active_mode) = active_mode else {
                        return;
                    };
                    let Ok(rect) = current_window_rect(&tracked_window) else {
                        return;
                    };
                    match active_mode {
                        WindowMode::Peek => {
                            let peek_size = *app_state.peek_size.lock().await;
                            let mut guard = app_state.last_peek_rect.lock().await;
                            *guard =
                                peek_rect_for_origin(&tracked_window, rect.x, rect.y, peek_size)
                                    .ok();
                        }
                        WindowMode::Expanded => {
                            let mut guard = app_state.last_expanded_rect.lock().await;
                            *guard = clamp_window_rect_to_monitor(&tracked_window, rect).ok();
                        }
                    }
                    let revision = {
                        let mut guard = drag_tracking_revision_state.lock().await;
                        *guard += 1;
                        *guard
                    };
                    let drag_tracking_mode_state = drag_tracking_mode_state.clone();
                    let drag_tracking_revision_state = drag_tracking_revision_state.clone();
                    let app_state = app_state.clone();
                    async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(170)).await;
                        let current_revision = *drag_tracking_revision_state.lock().await;
                        if current_revision != revision {
                            return;
                        }
                        let active_mode = *drag_tracking_mode_state.lock().await;
                        if active_mode.is_none() {
                            return;
                        }
                        {
                            let mut guard = drag_tracking_mode_state.lock().await;
                            *guard = None;
                        }
                        persist_window_state(&app_state).await;
                    });
                });
            });

            // --- System tray ---
            let show_hide_label = ui_text("tray.showHide");
            let show_hide = MenuItemBuilder::with_id("show_hide", &show_hide_label).build(app)?;
            let open_agent_label = ui_text("tray.openAgent");
            let open_agent = MenuItemBuilder::with_id("peek_open", &open_agent_label).build(app)?;
            let collapse_to_peek_label = ui_text("tray.collapseToPeek");
            let collapse_to_peek =
                MenuItemBuilder::with_id("peek_collapse", &collapse_to_peek_label).build(app)?;
            let peek_pos_top_left =
                MenuItemBuilder::with_id("peek_pos_top_left", ui_text("tray.peekTopLeft"))
                    .build(app)?;
            let peek_pos_top_right =
                MenuItemBuilder::with_id("peek_pos_top_right", ui_text("tray.peekTopRight"))
                    .build(app)?;
            let peek_pos_bottom_left =
                MenuItemBuilder::with_id("peek_pos_bottom_left", ui_text("tray.peekBottomLeft"))
                    .build(app)?;
            let peek_pos_bottom_right =
                MenuItemBuilder::with_id("peek_pos_bottom_right", ui_text("tray.peekBottomRight"))
                    .build(app)?;
            let peek_position_menu =
                SubmenuBuilder::with_id(app, "peek_position", ui_text("tray.peekPosition"))
                    .item(&peek_pos_top_left)
                    .item(&peek_pos_top_right)
                    .item(&peek_pos_bottom_left)
                    .item(&peek_pos_bottom_right)
                    .build()?;
            let reset_window_position = MenuItemBuilder::with_id(
                "peek_reset_position",
                ui_text("tray.resetWindowPosition"),
            )
            .build(app)?;

            // TTS toggle
            let tts_toggle_label = ui_text("tray.toggleTts");
            let tts_toggle =
                MenuItemBuilder::with_id("tts_toggle", &tts_toggle_label).build(app)?;
            let transcription_provider_realtime = MenuItemBuilder::with_id(
                "transcription_provider_realtime",
                ui_text("tray.transcriptionProviderRealtime"),
            )
            .build(app)?;
            let transcription_provider_file = MenuItemBuilder::with_id(
                "transcription_provider_file",
                ui_text("tray.transcriptionProviderFile"),
            )
            .build(app)?;
            let transcription_provider_menu = SubmenuBuilder::with_id(
                app,
                "transcription_provider",
                ui_text("tray.transcriptionProvider"),
            )
            .item(&transcription_provider_realtime)
            .item(&transcription_provider_file)
            .build()?;

            // Always on top toggle
            let always_on_top_label = ui_text("tray.toggleAlwaysOnTop");
            let always_on_top =
                MenuItemBuilder::with_id("always_on_top", &always_on_top_label).build(app)?;

            // API URL display (informational + click to copy)
            let config = app.state::<AppState>();
            let api_label = format!(
                "Agent Studio: {}",
                config
                    .config
                    .comm_officer_base_url
                    .as_deref()
                    .unwrap_or("nicht konfiguriert")
            );
            let api_url_item = MenuItemBuilder::with_id("api_url", &api_label).build(app)?;

            let quit_label = ui_text("tray.quit");
            let quit = MenuItemBuilder::with_id("quit", &quit_label).build(app)?;

            let menu = MenuBuilder::new(app)
                .item(&show_hide)
                .item(&open_agent)
                .item(&collapse_to_peek)
                .item(&peek_position_menu)
                .item(&reset_window_position)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&tts_toggle)
                .item(&transcription_provider_menu)
                .item(&always_on_top)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&api_url_item)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .icon(Image::from_bytes(include_bytes!(
                    "../icons/menubar-icon.png"
                ))?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("SYNTRA Assistant")
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref();
                    match id {
                        "show_hide" => {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.is_visible().unwrap_or(false) {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                    let _ = win.emit("peek-open", ());
                                }
                            }
                        }
                        "peek_open" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                                let _ = win.emit("peek-open", ());
                            }
                        }
                        "peek_collapse" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit("peek-collapse", ());
                            }
                        }
                        "peek_pos_top_left"
                        | "peek_pos_top_right"
                        | "peek_pos_bottom_left"
                        | "peek_pos_bottom_right" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let next = match id {
                                    "peek_pos_top_left" => PeekPosition::TopLeft,
                                    "peek_pos_top_right" => PeekPosition::TopRight,
                                    "peek_pos_bottom_left" => PeekPosition::BottomLeft,
                                    _ => PeekPosition::BottomRight,
                                };
                                let state = app.state::<AppState>();
                                let peek_state = state.peek_position.clone();
                                let peek_rect_state = state.last_peek_rect.clone();
                                let peek_size_state = state.peek_size.clone();
                                let app_state = state.inner().clone();
                                let win_for_state = win.clone();
                                async_runtime::spawn(async move {
                                    let mut guard = peek_state.lock().await;
                                    *guard = next;
                                    let peek_size = *peek_size_state.lock().await;
                                    let mut peek_rect_guard = peek_rect_state.lock().await;
                                    *peek_rect_guard =
                                        peek_rect_for_position(&win_for_state, next, peek_size)
                                            .ok();
                                    persist_window_state(&app_state).await;
                                });
                                if let Ok(current) = current_window_rect(&win) {
                                    if current.width <= MAX_PEEK_WIDTH + 2.0
                                        && current.height <= MAX_PEEK_HEIGHT + 2.0
                                    {
                                        let state = app.state::<AppState>();
                                        let peek_size = *state.peek_size.blocking_lock();
                                        if let Ok(target) =
                                            peek_rect_for_position(&win, next, peek_size)
                                        {
                                            let _ = apply_window_rect(&win, target);
                                        }
                                    }
                                }
                                let _ = win.emit(
                                    "peek-position-changed",
                                    match next {
                                        PeekPosition::TopLeft => "top-left",
                                        PeekPosition::TopRight => "top-right",
                                        PeekPosition::BottomLeft => "bottom-left",
                                        PeekPosition::BottomRight => "bottom-right",
                                    },
                                );
                            }
                        }
                        "peek_reset_position" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let state = app.state::<AppState>();
                                let app_state = state.inner().clone();
                                async_runtime::spawn(async move {
                                    let default_position = PeekPosition::default();
                                    let current = current_window_rect(&win).ok();
                                    let current_mode = *app_state.current_window_mode.lock().await;
                                    let saved_expanded_rect =
                                        *app_state.last_expanded_rect.lock().await;
                                    let expanded_size = saved_expanded_rect
                                        .map(|rect| (rect.width, rect.height))
                                        .unwrap_or((
                                            current
                                                .map(|rect| rect.width)
                                                .unwrap_or(EXPANDED_WIDTH),
                                            current
                                                .map(|rect| rect.height)
                                                .unwrap_or(EXPANDED_HEIGHT),
                                        ));
                                    let peek_size = *app_state.peek_size.lock().await;
                                    let default_peek_rect =
                                        peek_rect_for_position(&win, default_position, peek_size)
                                            .ok();
                                    let default_expanded_rect = expanded_rect_for_position(
                                        &win,
                                        default_position,
                                        expanded_size.0.max(420.0),
                                        expanded_size.1.max(420.0),
                                    )
                                    .ok();

                                    {
                                        let mut guard = app_state.peek_position.lock().await;
                                        *guard = default_position;
                                    }
                                    {
                                        let mut guard = app_state.last_peek_rect.lock().await;
                                        *guard = default_peek_rect;
                                    }
                                    {
                                        let mut guard = app_state.last_expanded_rect.lock().await;
                                        *guard = default_expanded_rect;
                                    }

                                    let target = match current_mode {
                                        WindowMode::Peek => default_peek_rect,
                                        WindowMode::Expanded => default_expanded_rect,
                                    };
                                    if let Some(rect) = target {
                                        {
                                            let mut guard =
                                                app_state.suppress_window_tracking.lock().await;
                                            *guard = true;
                                        }
                                        let _ = apply_window_rect(&win, rect);
                                        {
                                            let mut guard =
                                                app_state.suppress_window_tracking.lock().await;
                                            *guard = false;
                                        }
                                    }
                                    persist_window_state(&app_state).await;
                                    let _ = win.emit("peek-position-changed", "top-right");
                                });
                            }
                        }
                        "tts_toggle" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.emit("tray-tts-toggle", ());
                            }
                        }
                        "transcription_provider_realtime" | "transcription_provider_file" => {
                            let provider = if id == "transcription_provider_file" {
                                TranscriptionProviderId::OpenAiFileFallback
                            } else {
                                TranscriptionProviderId::OpenAiRealtime
                            };
                            let state = app.state::<AppState>();
                            let provider_state = state.transcription_provider.clone();
                            if let Some(win) = app.get_webview_window("main") {
                                let win_clone = win.clone();
                                async_runtime::spawn(async move {
                                    {
                                        let mut guard = provider_state.lock().await;
                                        *guard = provider;
                                    }
                                    let _ =
                                        emit_transcription_provider_changed(&win_clone, provider);
                                });
                            }
                        }
                        "always_on_top" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let current = win.is_always_on_top().unwrap_or(true);
                                let _ = win.set_always_on_top(!current);
                            }
                        }
                        "api_url" => {
                            // Copy the configured Agent Studio URL to clipboard.
                            let state = app.state::<AppState>();
                            let url = state
                                .config
                                .comm_officer_base_url
                                .clone()
                                .unwrap_or_default();
                            #[cfg(target_os = "macos")]
                            {
                                let _ = std::process::Command::new("pbcopy")
                                    .stdin(std::process::Stdio::piped())
                                    .spawn()
                                    .and_then(|mut child| {
                                        use std::io::Write;
                                        if let Some(stdin) = child.stdin.as_mut() {
                                            let _ = stdin.write_all(url.as_bytes());
                                        }
                                        child.wait()
                                    });
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                            let _ = win.emit("peek-open", ());
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { code, api, .. } = event {
            let state = app.state::<AppState>();
            if !state.shutdown_started.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                let app = app.clone();
                async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    reset_agent_studio_activity(state.inner()).await;
                    app.exit(code.unwrap_or(0));
                });
            }
        }
    });
}

fn main() {
    run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_collects_multiline_data() {
        let mut parser = SseParser {
            current: SseFrame::new(),
        };

        assert!(parser.push_line("event: final").is_none());
        assert!(parser
            .push_line("data: {\"speechText\":\"Hallo\",")
            .is_none());
        assert!(parser
            .push_line("data: \"displayText\":\"Hallo\"}")
            .is_none());

        let frame = parser.push_line("").unwrap();
        assert_eq!(frame.event, "final");
        assert_eq!(
            frame.data(),
            "{\"speechText\":\"Hallo\",\n\"displayText\":\"Hallo\"}"
        );
    }

    #[test]
    fn privileged_request_input_rejects_tenant_and_free_header_overrides() {
        let payload = serde_json::json!({
            "clientRequestId": "client-1",
            "utterance": "tenant-bound request",
            "tenantId": "tenant-b",
            "headers": { "x-tenant-id": "tenant-b" }
        });

        assert!(serde_json::from_value::<CreateDesktopAvatarRequestInput>(payload).is_err());
    }

    #[test]
    fn mime_type_mapping_supports_vrm_assets() {
        assert_eq!(mime_type_for_path("/tmp/avatar.vrm"), "model/gltf-binary");
        assert_eq!(mime_type_for_path("/tmp/idle.vrma"), "model/gltf-binary");
        assert_eq!(
            mime_type_for_path("/tmp/idle.fbx"),
            "application/octet-stream"
        );
    }

    #[test]
    fn manifest_paths_are_resolved_against_manifest_directory() {
        let mut manifest = AvatarManifest {
            display_name: Some("Mint".to_string()),
            license: Some("CC0".to_string()),
            thumbnail_url: None,
            model_url: Some("./sample-assets/mint-packed.glb".to_string()),
            animation_mapping: Some(HashMap::from([(
                "working".to_string(),
                "thinking".to_string(),
            )])),
            vrm_url: Some("./sample-assets/mint.vrm".to_string()),
            idle_animation_urls: vec![
                "https://www.opensourceavatars.com/animations/Warrior%20Idle.fbx".to_string(),
                "./sample-assets/fallback.vrma".to_string(),
            ],
            attention_animation_url: Some("./sample-assets/attention.vrma".to_string()),
            thinking_animation_url: None,
            talking_animation_url: Some(
                "https://www.opensourceavatars.com/animations/Looking.fbx".to_string(),
            ),
        };

        resolve_avatar_manifest_paths(&mut manifest, Path::new("/tmp/avatar-config"));

        assert_eq!(
            manifest.model_url.as_deref(),
            Some("/tmp/avatar-config/./sample-assets/mint-packed.glb")
        );
        assert_eq!(
            manifest.vrm_url.as_deref(),
            Some("/tmp/avatar-config/./sample-assets/mint.vrm")
        );
        assert_eq!(
            manifest.idle_animation_urls[0],
            "https://www.opensourceavatars.com/animations/Warrior%20Idle.fbx"
        );
        assert_eq!(
            manifest.idle_animation_urls[1],
            "/tmp/avatar-config/./sample-assets/fallback.vrma"
        );
        assert_eq!(
            manifest.attention_animation_url.as_deref(),
            Some("/tmp/avatar-config/./sample-assets/attention.vrma")
        );
        assert_eq!(
            manifest.talking_animation_url.as_deref(),
            Some("https://www.opensourceavatars.com/animations/Looking.fbx")
        );
    }

    #[test]
    fn tts_provider_name_is_stable_for_devtools() {
        assert_eq!(tts_provider_name(TtsProviderMode::Local), "local");
        assert_eq!(tts_provider_name(TtsProviderMode::FishAudio), "fish");
        assert_eq!(tts_provider_name(TtsProviderMode::OpenAI), "openai");
        assert_eq!(tts_provider_name(TtsProviderMode::System), "system");
    }

    #[test]
    fn tts_state_event_serialization_skips_optional_fields_when_absent() {
        let event = TtsStateEvent {
            context_id: "context-a".to_string(),
            request_id: "req-1".to_string(),
            speaking: false,
            provider: None,
            fallback: None,
        };
        let value = serde_json::to_value(event).expect("event to serialize");
        let object = value
            .as_object()
            .expect("serialized tts event to be an object");
        assert_eq!(
            object.get("contextId").and_then(Value::as_str),
            Some("context-a")
        );
        assert_eq!(
            object.get("requestId").and_then(Value::as_str),
            Some("req-1")
        );
        assert_eq!(object.get("speaking").and_then(Value::as_bool), Some(false));
        assert!(!object.contains_key("provider"));
        assert!(!object.contains_key("fallback"));
    }

    #[test]
    fn normalize_tts_text_collapses_whitespace() {
        assert_eq!(normalize_tts_text("  Hallo   zusammen  "), "Hallo zusammen");
        assert_eq!(normalize_tts_text("A\n\nB\t C"), "A B C");
    }

    #[test]
    fn duplicate_tts_detection_is_request_scoped() {
        let mut cache = HashMap::<String, u64>::new();
        let first_text = normalize_tts_text("Zeig   mir  Bestellungen");
        let same_text = normalize_tts_text("Zeig mir Bestellungen");
        let next_text = normalize_tts_text("Zeig mir offene Bestellungen");

        assert!(!should_skip_duplicate_tts_entry(
            &mut cache,
            "req-1",
            &first_text
        ));
        assert!(should_skip_duplicate_tts_entry(
            &mut cache, "req-1", &same_text
        ));
        assert!(!should_skip_duplicate_tts_entry(
            &mut cache, "req-1", &next_text
        ));
        assert!(!should_skip_duplicate_tts_entry(
            &mut cache, "req-2", &same_text
        ));
    }

    #[test]
    fn local_tts_endpoint_candidates_include_raw_then_audio_fallback() {
        assert_eq!(
            local_tts_endpoint_candidates("http://127.0.0.1:1234"),
            vec![
                "http://127.0.0.1:1234/".to_string(),
                "http://127.0.0.1:1234/v1".to_string(),
                "http://127.0.0.1:1234/v1/audio/speech".to_string()
            ]
        );
        assert_eq!(
            local_tts_endpoint_candidates("http://127.0.0.1:1234/v1"),
            vec![
                "http://127.0.0.1:1234/v1".to_string(),
                "http://127.0.0.1:1234/v1/audio/speech".to_string()
            ]
        );
        assert_eq!(
            local_tts_endpoint_candidates("http://127.0.0.1:1234/v1/audio/speech"),
            vec!["http://127.0.0.1:1234/v1/audio/speech".to_string()]
        );
    }

    #[test]
    fn startup_origin_prefers_last_peek_rect_over_last_expanded_rect() {
        let state = PersistedWindowState {
            peek_position: PeekPosition::TopRight,
            peek_size: default_peek_size(),
            last_peek_rect: Some(WindowRect {
                x: 111.0,
                y: 222.0,
                width: DEFAULT_PEEK_WIDTH,
                height: DEFAULT_PEEK_HEIGHT,
            }),
            last_expanded_rect: Some(WindowRect {
                x: 999.0,
                y: 888.0,
                width: EXPANDED_WIDTH,
                height: EXPANDED_HEIGHT,
            }),
        };

        assert_eq!(startup_peek_origin(&state), Some((111.0, 222.0)));
    }

    #[test]
    fn startup_origin_ignores_last_expanded_rect_when_no_peek_rect_exists() {
        let state = PersistedWindowState {
            peek_position: PeekPosition::TopRight,
            peek_size: default_peek_size(),
            last_peek_rect: None,
            last_expanded_rect: Some(WindowRect {
                x: 333.0,
                y: 444.0,
                width: EXPANDED_WIDTH,
                height: EXPANDED_HEIGHT,
            }),
        };

        assert_eq!(startup_peek_origin(&state), None);
    }

    #[test]
    fn normalize_language_code_accepts_locale_variants() {
        assert_eq!(normalize_language_code("de-DE"), Some("de".to_string()));
        assert_eq!(
            normalize_language_code("en_US.UTF-8"),
            Some("en".to_string())
        );
    }

    #[test]
    fn normalize_language_code_rejects_shell_placeholders() {
        assert_eq!(normalize_language_code("C"), None);
        assert_eq!(normalize_language_code("POSIX"), None);
    }

    #[tokio::test]
    async fn tts_shutdown_waits_for_child_termination_acknowledgement() {
        let terminated = Arc::new(AtomicBool::new(false));
        let task_terminated = terminated.clone();
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = oneshot::channel();
        tokio::spawn(async move {
            let _ = cancel_rx.await;
            task_terminated.store(true, Ordering::SeqCst);
            let _ = stopped_tx.send(());
        });

        cancel_tts_process_handles(vec![TtsProcessHandle {
            cancel: cancel_tx,
            stopped: stopped_rx,
        }])
        .await;

        assert!(terminated.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn stale_stream_cleanup_cannot_remove_replacement_owner() {
        let old_handle = async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        let new_handle = async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        let mut streams = HashMap::from([(
            "same-id".to_string(),
            OwnedStreamHandle {
                owner_id: "owner-old".to_string(),
                context_id: "context-a".to_string(),
                handle: old_handle,
            },
        )]);
        let replaced = streams.insert(
            "same-id".to_string(),
            OwnedStreamHandle {
                owner_id: "owner-new".to_string(),
                context_id: "context-b".to_string(),
                handle: new_handle,
            },
        );
        replaced.expect("old stream").handle.abort();

        assert!(
            remove_stream_if_owner(&mut streams, "same-id", "owner-old").is_none(),
            "old A cleanup must not remove the B replacement"
        );
        let current = streams.remove("same-id").expect("replacement stream");
        assert_eq!(current.context_id, "context-b");
        current.handle.abort();
    }

    #[tokio::test]
    async fn stale_single_stream_cleanup_cannot_remove_replacement_owner() {
        let handle = async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        let mut slot = Some(OwnedStreamHandle {
            owner_id: "owner-new".to_string(),
            context_id: "context-b".to_string(),
            handle,
        });

        assert!(take_stream_if_owner(&mut slot, "owner-old").is_none());
        let current = slot.take().expect("replacement stream");
        assert_eq!(current.context_id, "context-b");
        current.handle.abort();
    }
}
