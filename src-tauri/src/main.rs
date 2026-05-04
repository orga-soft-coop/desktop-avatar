use std::{
    collections::{HashMap, HashSet},
    env, fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE},
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
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, State,
    WebviewWindow, WindowEvent,
};
use tokio::{process::Command, sync::Mutex};

const CHAT_STREAM_EVENT: &str = "chat-stream-event";
const DESKTOP_AVATAR_STREAM_EVENT: &str = "desktop-avatar-stream-event";
const DESKTOP_AVATAR_STREAM_LIFECYCLE_EVENT: &str = "desktop-avatar-stream-lifecycle";
const TTS_STATE_EVENT: &str = "tts-state";
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

#[derive(Clone)]
struct AppState {
    client: Client,
    config: Arc<AppConfig>,
    desktop_avatar_streams: Arc<Mutex<HashMap<String, async_runtime::JoinHandle<()>>>>,
    last_tts_text_by_request: Arc<Mutex<HashMap<String, String>>>,
    peek_position: Arc<Mutex<PeekPosition>>,
    current_window_mode: Arc<Mutex<WindowMode>>,
    last_peek_rect: Arc<Mutex<Option<WindowRect>>>,
    last_expanded_rect: Arc<Mutex<Option<WindowRect>>>,
    suppress_window_tracking: Arc<Mutex<bool>>,
    drag_tracking_mode: Arc<Mutex<Option<WindowMode>>>,
    drag_tracking_revision: Arc<Mutex<u64>>,
    peek_size: Arc<Mutex<WindowSize>>,
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
        Self::Expanded
    }
}

#[derive(Clone, Debug)]
struct AppConfig {
    comm_officer_base_url: Option<String>,
    comm_officer_token: Option<String>,
    openai_api_key: Option<String>,
    openai_stt_model: String,
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
    local_llm_base_url: String,
    local_llm_model: String,
    local_llm_api_key: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct LocalChatMessageInput {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LocalChatRequest {
    request_id: String,
    #[serde(rename = "prompt")]
    _prompt: String,
    messages: Vec<LocalChatMessageInput>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BusinessChatRequest {
    request_id: String,
    conversation_id: String,
    utterance: String,
    source: String,
    locale: String,
    route: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CreateDesktopAvatarRequestInput {
    client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_by: Option<String>,
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
#[serde(rename_all = "camelCase")]
struct CreateDesktopAvatarRequestResult {
    accepted: bool,
    avatar_request_id: String,
    status: String,
    stream_url: String,
    poll_url: String,
    idempotent: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarRequestDocument {
    #[serde(alias = "id")]
    avatar_request_id: String,
    client_request_id: String,
    requested_by: Option<String>,
    mode: Option<String>,
    modality: Option<String>,
    locale: Option<String>,
    timezone: Option<String>,
    utterance: Option<String>,
    response_modes: Option<Vec<String>>,
    status: String,
    response: Option<Value>,
    error: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopAvatarStreamLifecycleEvent {
    avatar_request_id: String,
    phase: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeechTranscriptionRequest {
    audio_base64: String,
    mime_type: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TtsStateEvent {
    request_id: String,
    speaking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StreamEnvelope<T: Serialize + Clone> {
    request_id: String,
    source: &'static str,
    kind: &'static str,
    payload: T,
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
    let Ok(value) = serde_json::from_str::<Value>(include_str!("../../src/locales/de/ui.json")) else {
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

fn top_level_json_keys(value: &Value) -> String {
    value
        .as_object()
        .map(|object| {
            let mut keys = object.keys().cloned().collect::<Vec<String>>();
            keys.sort_unstable();
            keys.join(",")
        })
        .filter(|keys| !keys.is_empty())
        .unwrap_or_else(|| "<non-object>".to_string())
}

fn truncate_for_log(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    value.chars().take(max_len).collect::<String>() + "…"
}

fn should_skip_duplicate_tts_entry(
    cache: &mut HashMap<String, String>,
    request_id: &str,
    normalized_text: &str,
) -> bool {
    if normalized_text.trim().is_empty() {
        return false;
    }

    // Bound memory growth for long-running dev sessions.
    if cache.len() > 512 {
        cache.clear();
    }

    if cache
        .get(request_id)
        .is_some_and(|previous| previous == normalized_text)
    {
        return true;
    }

    cache.insert(request_id.to_string(), normalized_text.to_string());
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
        let _ = dotenvy::dotenv();
        let workspace_root = workspace_root();
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
        let log_file_path = workspace_root.join("tmp").join("desktop-avatar.log");
        let window_state_path = workspace_root.join("tmp").join("desktop-avatar-window-state.json");

        let _ = fs::create_dir_all(log_file_path.parent().unwrap_or_else(|| Path::new(".")));
        let _ = fs::write(&log_file_path, "");

        let tts_provider = env::var("TTS_PROVIDER")
            .map(|value| TtsProviderMode::parse(&value))
            .unwrap_or(TtsProviderMode::Auto);

        let openai_tts_default_voice =
            env::var("OPENAI_TTS_VOICE").unwrap_or_else(|_| "onyx".to_string());
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
            comm_officer_token: env::var("COMM_OFFICER_TOKEN").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            openai_stt_model: env::var("OPENAI_STT_MODEL")
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
            local_llm_base_url: env::var("LOCAL_LLM_BASE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:1234/v1".to_string()),
            local_llm_model: env::var("LOCAL_LLM_MODEL")
                .unwrap_or_else(|_| "qwen/qwen3.5-35b-a3b".to_string()),
            local_llm_api_key: env::var("LOCAL_LLM_API_KEY").ok(),
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
        format!(
            "bootstrap: avatar manifest path = {}",
            state
                .config
                .avatar_asset_manifest
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<none>".to_string())
        ),
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
                    "bootstrap: resolved model = {} vrm = {} idle clips = {}",
                    manifest
                        .model_url
                        .as_deref()
                        .unwrap_or("<none>"),
                    manifest.vrm_url.as_deref().unwrap_or("<none>"),
                    manifest.idle_animation_urls.join(", ")
                ),
            );
            Some(manifest)
        }
        Some(path) => {
            append_log(
                &state.config.log_file_path,
                format!("bootstrap: manifest missing on disk: {}", path.display()),
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
    })
}

#[tauri::command]
async fn load_avatar_asset(path: String) -> Result<AssetPayload, String> {
    append_log(
        &workspace_root().join("tmp").join("desktop-avatar.log"),
        format!("asset: loading {path}"),
    );
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
    append_log(
        &state.config.log_file_path,
        format!("frontend:{level}: {message}"),
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
    let diameter = width.min(height).clamp(150.0, MAX_PEEK_WIDTH.min(MAX_PEEK_HEIGHT));
    WindowSize {
        width: diameter,
        height: diameter,
    }
}

fn clamp_window_rect_to_monitor(window: &WebviewWindow, rect: WindowRect) -> Result<WindowRect, String> {
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
) -> Result<(), String> {
    let animate = animated.unwrap_or(true);
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
            WindowMode::Expanded => {
                expanded_rect_for_origin(&window, current.x, current.y, target.width, target.height)?
            }
        };
        if rect_origin_delta(stage_target, target) <= 1.0 {
            animate_window_rect(&window, current, target, TRANSITION_DURATION_MS).await
        } else {
            animate_window_rect(&window, current, stage_target, TRANSITION_STAGE_DURATION_MS).await?;
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
    persist_window_state(state.inner()).await;
    Ok(())
}

fn comm_officer_credentials(config: &AppConfig) -> Result<(String, String), String> {
    let base_url = config
        .comm_officer_base_url
        .clone()
        .ok_or_else(|| "COMM_OFFICER_BASE_URL is missing.".to_string())?;
    let token = config
        .comm_officer_token
        .clone()
        .ok_or_else(|| "COMM_OFFICER_TOKEN is missing.".to_string())?;

    Ok((base_url, token))
}

fn absolute_comm_officer_url(base_url: &str, path_or_url: &str) -> String {
    if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        return path_or_url.to_string();
    }

    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path_or_url.trim_start_matches('/')
    )
}

fn with_auth(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request.header(AUTHORIZATION, format!("Bearer {token}"))
}

fn normalize_desktop_avatar_result_urls(
    base_url: &str,
    result: &mut CreateDesktopAvatarRequestResult,
) {
    result.stream_url = absolute_comm_officer_url(base_url, &result.stream_url);
    result.poll_url = absolute_comm_officer_url(base_url, &result.poll_url);
}

#[tauri::command]
async fn desktop_avatar_request_create(
    state: State<'_, AppState>,
    request: CreateDesktopAvatarRequestInput,
) -> Result<CreateDesktopAvatarRequestResult, String> {
    let (base_url, token) = comm_officer_credentials(state.config.as_ref())?;
    let url = absolute_comm_officer_url(&base_url, "/v1/desktop-avatar/requests");

    let response = with_auth(
        state
            .client
            .post(url)
            .header(CONTENT_TYPE, "application/json")
            .json(&request),
        &token,
    )
    .send()
    .await
    .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".into());
        return Err(format!("Desktop Avatar create returned {status}: {text}"));
    }

    let mut result = response
        .json::<CreateDesktopAvatarRequestResult>()
        .await
        .map_err(|error| error.to_string())?;
    normalize_desktop_avatar_result_urls(&base_url, &mut result);
    Ok(result)
}

#[tauri::command]
async fn desktop_avatar_request_get(
    state: State<'_, AppState>,
    avatar_request_id: Option<String>,
    poll_url: Option<String>,
) -> Result<DesktopAvatarRequestDocument, String> {
    let (base_url, token) = comm_officer_credentials(state.config.as_ref())?;
    let url = match (avatar_request_id, poll_url) {
        (_, Some(url)) => absolute_comm_officer_url(&base_url, &url),
        (Some(request_id), None) => absolute_comm_officer_url(
            &base_url,
            &format!("/v1/desktop-avatar/requests/{request_id}"),
        ),
        (None, None) => {
            return Err(
                "desktop_avatar_request_get requires avatarRequestId or pollUrl.".to_string(),
            )
        }
    };

    let response = with_auth(state.client.get(url), &token)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".into());
        return Err(format!("Desktop Avatar poll returned {status}: {text}"));
    }

    response
        .json::<DesktopAvatarRequestDocument>()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn desktop_avatar_request_stream(
    window: WebviewWindow,
    state: State<'_, AppState>,
    avatar_request_id: Option<String>,
    stream_url: Option<String>,
) -> Result<(), String> {
    let (base_url, token) = comm_officer_credentials(state.config.as_ref())?;
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
        Some(url) => absolute_comm_officer_url(&base_url, &url),
        None => absolute_comm_officer_url(
            &base_url,
            &format!("/v1/desktop-avatar/requests/{request_id}/stream"),
        ),
    };

    if let Some(existing) = state
        .desktop_avatar_streams
        .lock()
        .await
        .remove(request_id.as_str())
    {
        existing.abort();
    }

    let client = state.client.clone();
    let streams = state.desktop_avatar_streams.clone();
    let request_id_for_task = request_id.clone();
    let handle = async_runtime::spawn(async move {
        let response = with_auth(
            client
                .get(url)
                .header(ACCEPT, "text/event-stream")
                .header(CONTENT_TYPE, "application/json"),
            &token,
        )
        .send()
        .await;

        match response {
            Ok(response) => {
                if let Err(error) = process_desktop_avatar_stream(
                    window.clone(),
                    request_id_for_task.clone(),
                    response,
                )
                .await
                {
                    let _ = emit_desktop_avatar_stream_lifecycle(
                        &window,
                        request_id_for_task.as_str(),
                        "error",
                        Some(error),
                    );
                } else {
                    let _ = emit_desktop_avatar_stream_lifecycle(
                        &window,
                        request_id_for_task.as_str(),
                        "closed",
                        None,
                    );
                }
            }
            Err(error) => {
                let _ = emit_desktop_avatar_stream_lifecycle(
                    &window,
                    request_id_for_task.as_str(),
                    "error",
                    Some(error.to_string()),
                );
            }
        }

        streams.lock().await.remove(request_id_for_task.as_str());
    });

    state
        .desktop_avatar_streams
        .lock()
        .await
        .insert(request_id, handle);

    Ok(())
}

#[tauri::command]
async fn desktop_avatar_request_stream_stop(
    window: WebviewWindow,
    state: State<'_, AppState>,
    avatar_request_id: String,
) -> Result<(), String> {
    if let Some(handle) = state
        .desktop_avatar_streams
        .lock()
        .await
        .remove(avatar_request_id.as_str())
    {
        handle.abort();
    }

    emit_desktop_avatar_stream_lifecycle(&window, avatar_request_id.as_str(), "aborted", None)
}

#[tauri::command]
async fn chat_send_business(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: BusinessChatRequest,
) -> Result<(), String> {
    let base_url = state
        .config
        .comm_officer_base_url
        .clone()
        .ok_or_else(|| "COMM_OFFICER_BASE_URL is missing.".to_string())?;
    let token = state
        .config
        .comm_officer_token
        .clone()
        .ok_or_else(|| "COMM_OFFICER_TOKEN is missing.".to_string())?;

    let client = state.client.clone();
    async_runtime::spawn(async move {
        let body = json!({
            "conversationId": request.conversation_id,
            "utterance": request.utterance,
            "source": request.source,
            "locale": request.locale,
            "desktopContext": {
                "route": request.route,
                "localeIdentifier": request.locale
            }
        });

        let response = client
            .post(format!("{base_url}/avatar/query"))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "text/event-stream")
            .header(AUTHORIZATION, format!("Bearer {token}"))
            .json(&body)
            .send()
            .await;

        match response {
            Ok(response) => {
                if let Err(error) =
                    process_business_stream(window.clone(), request.request_id.clone(), response)
                        .await
                {
                    let _ = emit_stream_event(
                        &window,
                        request.request_id.as_str(),
                        "business",
                        "error",
                        json!({ "message": error }),
                    );
                }
            }
            Err(error) => {
                let _ = emit_stream_event(
                    &window,
                    request.request_id.as_str(),
                    "business",
                    "error",
                    json!({ "message": error.to_string() }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn chat_send_local(
    window: WebviewWindow,
    state: State<'_, AppState>,
    request: LocalChatRequest,
) -> Result<(), String> {
    let client = state.client.clone();
    let config = state.config.clone();

    async_runtime::spawn(async move {
        let url = format!(
            "{}/chat/completions",
            config.local_llm_base_url.trim_end_matches('/')
        );

        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        if let Some(api_key) = &config.local_llm_api_key {
            if !api_key.trim().is_empty() {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {api_key}")) {
                    headers.insert(AUTHORIZATION, value);
                }
            }
        }

        let body = json!({
            "model": config.local_llm_model,
            "stream": true,
            "messages": request.messages,
            "temperature": 0.5
        });

        let response = client.post(url).headers(headers).json(&body).send().await;
        match response {
            Ok(response) => {
                if let Err(error) =
                    process_local_stream(window.clone(), request.request_id.clone(), response).await
                {
                    let _ = emit_stream_event(
                        &window,
                        request.request_id.as_str(),
                        "local",
                        "error",
                        json!({ "message": error }),
                    );
                }
            }
            Err(error) => {
                let _ = emit_stream_event(
                    &window,
                    request.request_id.as_str(),
                    "local",
                    "error",
                    json!({ "message": error.to_string() }),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn speech_transcribe(
    state: State<'_, AppState>,
    request: SpeechTranscriptionRequest,
) -> Result<String, String> {
    let api_key = state
        .config
        .openai_api_key
        .clone()
        .ok_or_else(|| "OPENAI_API_KEY is missing.".to_string())?;

    let audio = BASE64
        .decode(request.audio_base64.as_bytes())
        .map_err(|error| error.to_string())?;

    let extension = mime_extension(&request.mime_type);
    let part = Part::bytes(audio)
        .file_name(format!("speech.{extension}"))
        .mime_str(&request.mime_type)
        .map_err(|error| error.to_string())?;

    let form = Form::new()
        .part("file", part)
        .text("model", state.config.openai_stt_model.clone())
        .text("language", current_language());

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
        return Err(value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("The transcription request failed.")
            .to_string());
    }

    Ok(value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string())
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
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let normalized_text = normalize_tts_text(&text);
        let should_skip = {
            let mut cache = state.last_tts_text_by_request.lock().await;
            should_skip_duplicate_tts_entry(&mut cache, &request_id, &normalized_text)
        };
        if should_skip {
            append_log(
                &state.config.log_file_path,
                format!(
                    "tts: duplicate suppressed (requestId={request_id}, text={normalized_text})"
                ),
            );
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
            let is_fallback = provider_index > 0;
            let provider_name = tts_provider_name(provider);
            let result = match provider {
                TtsProviderMode::Local => {
                    speak_local_tts(
                        state.inner(),
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
                        &window,
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
                    format!(
                        "tts: provider={provider_name} selected (requestId={request_id}, fallback={is_fallback})"
                    ),
                );
                return Ok(());
            }

            let message = result
                .err()
                .unwrap_or_else(|| "Unknown TTS provider error.".to_string());
            append_log(
                &state.config.log_file_path,
                format!(
                    "tts: provider={provider:?} failed (requestId={request_id}), error={message}"
                ),
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
        emit_tts_state(&window, &request_id, false, None, None)?;
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
async fn speak_system_tts(
    window: &WebviewWindow,
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

    let mut child = command
        .arg("-r")
        .arg("185")
        .arg(text)
        .spawn()
        .map_err(|error| error.to_string())?;

    emit_tts_state(
        window,
        request_id,
        true,
        Some(provider_name),
        Some(fallback_used),
    )?;
    let window_clone = window.clone();
    let request_id = request_id.to_string();
    let provider_name = provider_name.to_string();
    async_runtime::spawn(async move {
        let _ = child.wait().await;
        let _ = emit_tts_state(
            &window_clone,
            &request_id,
            false,
            Some(provider_name.as_str()),
            Some(fallback_used),
        );
    });
    Ok(())
}

#[cfg(target_os = "macos")]
async fn speak_local_tts(
    state: &AppState,
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
        append_log(
            &state.config.log_file_path,
            format!("tts: provider=local attempt requestId={request_id}, endpoint={endpoint}"),
        );
        match speak_http_tts(
            state,
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
                    format!(
                        "tts: provider=local endpoint failed requestId={request_id}, endpoint={endpoint}, error={}",
                        truncate_for_log(&error, 240)
                    ),
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
        append_log(
            &state.config.log_file_path,
            format!("tts: provider=fish attempt requestId={request_id}, endpoint={endpoint}"),
        );
        match speak_http_tts(
            state,
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
                    format!(
                        "tts: provider=fish endpoint failed requestId={request_id}, endpoint={endpoint}, error={}",
                        truncate_for_log(&error, 240)
                    ),
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
            "tts:http start provider={provider_name} requestId={request_id} fallback={fallback_used} endpoint={endpoint} model={model} voice={selected_voice} chars={} payloadKeys={}",
            text.chars().count(),
            top_level_json_keys(&payload),
        ),
    );
    let response = request
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            let message = error.to_string();
            append_log(
                &state.config.log_file_path,
                format!(
                    "tts:http transport-error provider={provider_name} requestId={request_id} endpoint={endpoint} error={}",
                    truncate_for_log(&message, 320)
                ),
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
    append_log(
        &state.config.log_file_path,
        format!(
            "tts:http response provider={provider_name} requestId={request_id} endpoint={endpoint} status={} contentType={} bytes={}",
            status.as_u16(),
            response_content_type
                .as_deref()
                .unwrap_or("<none>"),
            body.len()
        ),
    );

    if !status.is_success() {
        let raw_preview = truncate_for_log(String::from_utf8_lossy(&body).trim(), 320);
        append_log(
            &state.config.log_file_path,
            format!(
                "tts:http non-success provider={provider_name} requestId={request_id} endpoint={endpoint} status={} body={}",
                status.as_u16(),
                raw_preview
            ),
        );
        let message = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                let raw = String::from_utf8_lossy(&body);
                let raw = raw.trim();
                if raw.is_empty() {
                    format!("{provider_name} TTS request failed with status {status}.")
                } else {
                    format!("{provider_name} TTS request failed with status {status}: {raw}")
                }
            });
        return Err(message);
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

    let extension = if is_json_content_type || looks_like_json {
        "mp3"
    } else {
        audio_file_extension_from_content_type(response_content_type.as_deref())
    };
    let request_id_safe: String = request_id
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '_'
            }
        })
        .collect();
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let temp_path = env::temp_dir().join(format!(
        "desktop-avatar-tts-{provider_name}-{request_id_safe}-{timestamp}.{extension}"
    ));
    fs::write(&temp_path, &bytes).map_err(|error| error.to_string())?;

    let mut child = Command::new("afplay")
        .arg(&temp_path)
        .spawn()
        .map_err(|error| error.to_string())?;

    emit_tts_state(
        window,
        request_id,
        true,
        Some(provider_name),
        Some(fallback_used),
    )?;
    let window_clone = window.clone();
    let request_id = request_id.to_string();
    let provider_name = provider_name.to_string();
    async_runtime::spawn(async move {
        let _ = child.wait().await;
        let _ = fs::remove_file(&temp_path);
        let _ = emit_tts_state(
            &window_clone,
            &request_id,
            false,
            Some(provider_name.as_str()),
            Some(fallback_used),
        );
    });

    Ok(())
}

#[tauri::command]
async fn tts_stop(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("killall").arg("say").spawn();
        let _ = Command::new("killall").arg("afplay").spawn();
    }

    emit_tts_state(&window, "global", false, None, None)
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

async fn process_business_stream(
    window: WebviewWindow,
    request_id: String,
    response: reqwest::Response,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".into());
        return Err(format!("Communication Officer returned {status}: {text}"));
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
                emit_stream_event(
                    &window,
                    request_id.as_str(),
                    "business",
                    map_business_kind(frame.event.as_str()),
                    payload,
                )?;
            }
        }
    }

    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        if let Some(frame) = parser.push_line(line.as_str()) {
            let payload: Value =
                serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
            emit_stream_event(
                &window,
                request_id.as_str(),
                "business",
                map_business_kind(frame.event.as_str()),
                payload,
            )?;
        }
    }

    if let Some(frame) = parser.finish() {
        let payload: Value =
            serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
        emit_stream_event(
            &window,
            request_id.as_str(),
            "business",
            map_business_kind(frame.event.as_str()),
            payload,
        )?;
    }

    Ok(())
}

async fn process_desktop_avatar_stream(
    window: WebviewWindow,
    request_id: String,
    response: reqwest::Response,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".into());
        return Err(format!("Desktop Avatar stream returned {status}: {text}"));
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
                emit_desktop_avatar_stream_event(&window, payload)?;
            }
        }
    }

    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        if let Some(frame) = parser.push_line(line.as_str()) {
            let payload: Value =
                serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
            emit_desktop_avatar_stream_event(&window, payload)?;
        }
    }

    if let Some(frame) = parser.finish() {
        let payload: Value =
            serde_json::from_str(frame.data().as_str()).map_err(|error| error.to_string())?;
        emit_desktop_avatar_stream_event(&window, payload)?;
    }

    append_log(
        &workspace_root().join("tmp").join("desktop-avatar.log"),
        format!("desktop-avatar stream closed: {request_id}"),
    );

    Ok(())
}

async fn process_local_stream(
    window: WebviewWindow,
    request_id: String,
    response: reqwest::Response,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .unwrap_or_else(|_| "Unknown error".into());
        return Err(format!("LM Studio returned {status}: {text}"));
    }

    let mut parser = SseParser {
        current: SseFrame::new(),
    };
    let mut pending = String::new();
    let mut accumulated = String::new();
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
                let data = frame.data();
                if data.trim() == "[DONE]" {
                    emit_stream_event(
                        &window,
                        request_id.as_str(),
                        "local",
                        "final",
                        json!({
                            "type": "generic_text",
                            "speechText": accumulated,
                            "displayText": accumulated,
                            "card": Value::Null
                        }),
                    )?;
                    return Ok(());
                }

                let payload: Value =
                    serde_json::from_str(data.as_str()).map_err(|error| error.to_string())?;
                if let Some(delta) = payload
                    .get("choices")
                    .and_then(Value::as_array)
                    .and_then(|choices| choices.first())
                    .and_then(|choice| choice.get("delta"))
                    .and_then(|delta| delta.get("content"))
                    .and_then(Value::as_str)
                {
                    accumulated.push_str(delta);
                    emit_stream_event(
                        &window,
                        request_id.as_str(),
                        "local",
                        "delta",
                        json!({
                            "delta": delta,
                            "accumulated": accumulated
                        }),
                    )?;
                }
            }
        }
    }

    emit_stream_event(
        &window,
        request_id.as_str(),
        "local",
        "final",
        json!({
            "type": "generic_text",
            "speechText": accumulated,
            "displayText": accumulated,
            "card": Value::Null
        }),
    )?;

    Ok(())
}

fn map_business_kind(event: &str) -> &'static str {
    match event {
        "acknowledged" => "acknowledged",
        "researching" => "researching",
        "tool_progress" => "tool_progress",
        "handoff_local" => "handoff_local",
        "final" => "final",
        "error" => "error",
        _ => "error",
    }
}

fn emit_stream_event<T: Serialize + Clone>(
    window: &WebviewWindow,
    request_id: &str,
    source: &'static str,
    kind: &'static str,
    payload: T,
) -> Result<(), String> {
    window
        .emit(
            CHAT_STREAM_EVENT,
            StreamEnvelope {
                request_id: request_id.to_string(),
                source,
                kind,
                payload,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_desktop_avatar_stream_event(window: &WebviewWindow, payload: Value) -> Result<(), String> {
    window
        .emit(DESKTOP_AVATAR_STREAM_EVENT, payload)
        .map_err(|error| error.to_string())
}

fn emit_desktop_avatar_stream_lifecycle(
    window: &WebviewWindow,
    avatar_request_id: &str,
    phase: &str,
    reason: Option<String>,
) -> Result<(), String> {
    window
        .emit(
            DESKTOP_AVATAR_STREAM_LIFECYCLE_EVENT,
            DesktopAvatarStreamLifecycleEvent {
                avatar_request_id: avatar_request_id.to_string(),
                phase: phase.to_string(),
                reason,
            },
        )
        .map_err(|error| error.to_string())
}

fn emit_tts_state(
    window: &WebviewWindow,
    request_id: &str,
    speaking: bool,
    provider: Option<&str>,
    fallback: Option<bool>,
) -> Result<(), String> {
    window
        .emit(
            TTS_STATE_EVENT,
            TtsStateEvent {
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
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
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
    append_log(
        &workspace_root().join("tmp").join("desktop-avatar.log"),
        format!("asset: remote fetch {path}"),
    );
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
    match mime {
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/webm" | "audio/webm;codecs=opus" => "webm",
        _ => "wav",
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

fn current_language() -> String {
    env::var("LANG")
        .ok()
        .and_then(|value| value.split('.').next().map(str::to_string))
        .and_then(|value| value.split('_').next().map(str::to_string))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "de".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let bootstrap_config = AppConfig::load();
    let mut persisted_window_state = read_persisted_window_state(&bootstrap_config.window_state_path);
    let normalized_peek_size = normalize_peek_size(
        persisted_window_state.peek_size.width,
        persisted_window_state.peek_size.height,
    );
    persisted_window_state.peek_size = normalized_peek_size;
    persisted_window_state.last_peek_rect = persisted_window_state.last_peek_rect.map(|rect| WindowRect {
        width: normalized_peek_size.width,
        height: normalized_peek_size.height,
        ..rect
    });
    let state = AppState {
        client: Client::new(),
        config: Arc::new(bootstrap_config),
        desktop_avatar_streams: Arc::new(Mutex::new(HashMap::new())),
        last_tts_text_by_request: Arc::new(Mutex::new(HashMap::new())),
        peek_position: Arc::new(Mutex::new(persisted_window_state.peek_position)),
        current_window_mode: Arc::new(Mutex::new(WindowMode::default())),
        last_peek_rect: Arc::new(Mutex::new(persisted_window_state.last_peek_rect)),
        last_expanded_rect: Arc::new(Mutex::new(persisted_window_state.last_expanded_rect)),
        suppress_window_tracking: Arc::new(Mutex::new(false)),
        drag_tracking_mode: Arc::new(Mutex::new(None)),
        drag_tracking_revision: Arc::new(Mutex::new(0)),
        peek_size: Arc::new(Mutex::new(persisted_window_state.peek_size)),
    };
    let provider_label = tts_provider_name(state.config.tts_provider);
    let local_tts_url = state
        .config
        .local_tts_url
        .as_deref()
        .unwrap_or("<none>");
    append_log(
        &state.config.log_file_path,
        format!(
            "tts: config provider={provider_label} localUrl={local_tts_url} localModel={} openaiEnabled={} localTemplateKeys={} localResponsePath={}",
            state.config.local_tts_model,
            state.config.openai_tts_available(),
            top_level_json_keys(&state.config.local_tts_request_template),
            state
                .config
                .local_tts_response_base64_path
                .as_deref()
                .unwrap_or("<auto>")
        ),
    );

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
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
            desktop_avatar_request_stream,
            desktop_avatar_request_stream_stop,
            chat_send_business,
            chat_send_local,
            speech_transcribe,
            tts_list_voices,
            tts_speak,
            tts_stop
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_always_on_top(true);
            let initial_position = persisted_window_state
                .last_expanded_rect
                .map(|rect| (rect.x, rect.y))
                .unwrap_or((64.0, 280.0));
            let _ = window.set_position(Position::Logical(LogicalPosition::new(
                initial_position.0,
                initial_position.1,
            )));
            let drag_tracking_mode_state = app.state::<AppState>().drag_tracking_mode.clone();
            let drag_tracking_revision_state =
                app.state::<AppState>().drag_tracking_revision.clone();
            let suppress_window_tracking_state =
                app.state::<AppState>().suppress_window_tracking.clone();
            let app_state = app.state::<AppState>().inner().clone();
            let tracked_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
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
                                *guard =
                                    peek_rect_for_origin(&tracked_window, rect.x, rect.y, peek_size)
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
            let peek_position_menu = SubmenuBuilder::with_id(
                app,
                "peek_position",
                ui_text("tray.peekPosition"),
            )
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
            let tts_toggle = MenuItemBuilder::with_id("tts_toggle", &tts_toggle_label).build(app)?;

            // Always on top toggle
            let always_on_top_label = ui_text("tray.toggleAlwaysOnTop");
            let always_on_top = MenuItemBuilder::with_id("always_on_top", &always_on_top_label)
                .build(app)?;

            // API URL display (informational + click to copy)
            let config = app.state::<AppState>();
            let llm_label = format!("LLM: {}", config.config.local_llm_base_url);
            let api_url_item = MenuItemBuilder::with_id("api_url", &llm_label).build(app)?;

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
                .item(&always_on_top)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&api_url_item)
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&quit)
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(Image::from_bytes(include_bytes!(
                    "../icons/menubar-icon.png"
                ))?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("DesktopAvatar")
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
                                        peek_rect_for_position(&win_for_state, next, peek_size).ok();
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
                                    let saved_expanded_rect = *app_state.last_expanded_rect.lock().await;
                                    let expanded_size = saved_expanded_rect
                                        .map(|rect| (rect.width, rect.height))
                                        .unwrap_or((
                                            current.map(|rect| rect.width).unwrap_or(EXPANDED_WIDTH),
                                            current.map(|rect| rect.height).unwrap_or(EXPANDED_HEIGHT),
                                        ));
                                    let peek_size = *app_state.peek_size.lock().await;
                                    let default_peek_rect =
                                        peek_rect_for_position(&win, default_position, peek_size).ok();
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
                        "always_on_top" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let current = win.is_always_on_top().unwrap_or(true);
                                let _ = win.set_always_on_top(!current);
                            }
                        }
                        "api_url" => {
                            // Copy the LLM URL to clipboard for convenience
                            let state = app.state::<AppState>();
                            let url = state.config.local_llm_base_url.clone();
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
            request_id: "req-1".to_string(),
            speaking: false,
            provider: None,
            fallback: None,
        };
        let value = serde_json::to_value(event).expect("event to serialize");
        let object = value
            .as_object()
            .expect("serialized tts event to be an object");
        assert_eq!(object.get("requestId").and_then(Value::as_str), Some("req-1"));
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
        let mut cache = HashMap::<String, String>::new();
        let first_text = normalize_tts_text("Zeig   mir  Bestellungen");
        let same_text = normalize_tts_text("Zeig mir Bestellungen");
        let next_text = normalize_tts_text("Zeig mir offene Bestellungen");

        assert!(!should_skip_duplicate_tts_entry(
            &mut cache,
            "req-1",
            &first_text
        ));
        assert!(should_skip_duplicate_tts_entry(
            &mut cache,
            "req-1",
            &same_text
        ));
        assert!(!should_skip_duplicate_tts_entry(
            &mut cache,
            "req-1",
            &next_text
        ));
        assert!(!should_skip_duplicate_tts_entry(
            &mut cache,
            "req-2",
            &same_text
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
}
