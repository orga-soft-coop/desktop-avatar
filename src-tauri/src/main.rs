mod learning;
mod speech;
mod transport;
mod window;
use speech::*;
use transport::*;
use window::*;

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
    log_file_path: PathBuf,
    window_state_path: PathBuf,
    enable_tts: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapState {
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
    Cancelled,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReplyDesktopAvatarClarificationInput {
    client_request_id: String,
    answer: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarDatasetColumn {
    key: String,
    label: String,
    data_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lookup: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarDatasetPage {
    result_id: String,
    columns: Vec<DesktopAvatarDatasetColumn>,
    rows: Vec<Value>,
    next_cursor: Option<String>,
    total_row_count: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarConversationCancelResult {
    conversation_id: String,
    status: String,
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
    #[serde(default)]
    conversation_id: Option<String>,
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

#[tauri::command]
async fn load_bootstrap_state(state: State<'_, AppState>) -> Result<BootstrapState, String> {
    Ok(BootstrapState {
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

fn desktop_avatar_resource_path(
    path_segments: &[&str],
    query: &[(&str, &str)],
) -> Result<String, String> {
    let mut url = Url::parse("https://desktop-avatar.invalid/")
        .map_err(|error| format!("Could not initialize Desktop Avatar URL: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Could not build Desktop Avatar resource path.".to_string())?;
        for segment in path_segments {
            segments.push(segment);
        }
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    Ok(path)
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
            frontend_log,
            window::window_set_peek_mode,
            window::window_set_peek_position,
            window::window_resize,
            window::window_get_geometry,
            window::window_start_drag,
            transport::desktop_avatar_request_create,
            transport::desktop_avatar_request_get,
            transport::desktop_avatar_clarification_reply,
            transport::desktop_avatar_dataset_page_get,
            transport::desktop_avatar_conversation_cancel,
            learning::learning_reviews_list,
            learning::learning_review_get,
            learning::learning_review_decide,
            learning::learning_review_revoke,
            transport::desktop_avatar_radar_get,
            transport::desktop_avatar_radar_stream_start,
            transport::desktop_avatar_radar_stream_stop,
            transport::desktop_avatar_request_stream,
            transport::desktop_avatar_request_stream_stop,
            transport::hitl_decision_stream_start,
            transport::hitl_decision_stream_stop,
            transport::hitl_decision_approve,
            transport::hitl_decision_reject,
            transport::hitl_request_more_info,
            speech::speech_transcribe,
            speech::transcription_provider_get,
            speech::transcription_provider_set,
            speech::transcription_session_start,
            speech::transcription_session_append_audio,
            speech::transcription_session_commit_turn,
            speech::transcription_session_stop,
            speech::tts_list_voices,
            speech::tts_speak,
            speech::tts_stop
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
                                    if win.hide().is_ok() {
                                        let _ = win.emit("avatar-window-visibility", false);
                                    }
                                } else {
                                    if win.show().is_ok() {
                                        let _ = win.emit("avatar-window-visibility", true);
                                    }
                                    let _ = win.set_focus();
                                    let _ = win.emit("peek-open", ());
                                }
                            }
                        }
                        "peek_open" => {
                            if let Some(win) = app.get_webview_window("main") {
                                if win.show().is_ok() {
                                    let _ = win.emit("avatar-window-visibility", true);
                                }
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
                            if win.show().is_ok() {
                                let _ = win.emit("avatar-window-visibility", true);
                            }
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
    fn desktop_avatar_resource_urls_encode_ids_and_cursors() {
        let url = desktop_avatar_resource_path(
            &[
                "v1",
                "desktop-avatar",
                "requests",
                "request/with spaces",
                "results",
                "result?1",
                "pages",
            ],
            &[("cursor", "next page&tenant=other")],
        )
        .expect("resource URL to be built");

        assert_eq!(
            url,
            "/v1/desktop-avatar/requests/request%2Fwith%20spaces/results/result%3F1/pages?cursor=next+page%26tenant%3Dother"
        );
    }

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
