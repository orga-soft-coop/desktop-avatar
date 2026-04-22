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
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, State,
    WebviewWindow,
};
use tokio::{process::Command, sync::Mutex};

const CHAT_STREAM_EVENT: &str = "chat-stream-event";
const DESKTOP_AVATAR_STREAM_EVENT: &str = "desktop-avatar-stream-event";
const DESKTOP_AVATAR_STREAM_LIFECYCLE_EVENT: &str = "desktop-avatar-stream-lifecycle";
const TTS_STATE_EVENT: &str = "tts-state";
const COLLAPSED_WIDTH: f64 = 520.0;
const COLLAPSED_HEIGHT: f64 = 600.0;
const EXPANDED_WIDTH: f64 = 720.0;
const EXPANDED_HEIGHT: f64 = 700.0;

#[derive(Clone)]
struct AppState {
    client: Client,
    config: Arc<AppConfig>,
    desktop_avatar_streams: Arc<Mutex<HashMap<String, async_runtime::JoinHandle<()>>>>,
    last_tts_text_by_request: Arc<Mutex<HashMap<String, String>>>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowSize {
    width: f64,
    height: f64,
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
            width: COLLAPSED_WIDTH,
            height: COLLAPSED_HEIGHT,
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
async fn window_toggle_expanded(
    window: WebviewWindow,
    expanded: bool,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let width = width.unwrap_or(if expanded {
        EXPANDED_WIDTH
    } else {
        COLLAPSED_WIDTH
    });
    let height = height.unwrap_or(if expanded {
        EXPANDED_HEIGHT
    } else {
        COLLAPSED_HEIGHT
    });
    resize_window_internal(&window, width, height)
}

#[tauri::command]
async fn window_resize(window: WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    resize_window_internal(&window, width, height)
}

#[tauri::command]
async fn window_start_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
async fn window_set_click_through(window: WebviewWindow, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())
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

fn resize_window_internal(window: &WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let target_height = height;
    let target_width = width;

    // Keep the top-left X position fixed; only grow/shrink downward.
    let mut new_x = position.x;
    let mut new_y = position.y;

    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let max_x = monitor_position.x + monitor_size.width as i32 - target_width as i32;
        let max_y = monitor_position.y + monitor_size.height as i32 - target_height as i32;

        new_x = new_x.clamp(monitor_position.x, max_x.max(monitor_position.x));
        new_y = new_y.clamp(monitor_position.y, max_y.max(monitor_position.y));
    }

    window
        .set_size(LogicalSize::new(target_width, target_height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Physical(PhysicalPosition::new(new_x, new_y)))
        .map_err(|error| error.to_string())?;
    Ok(())
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
    let state = AppState {
        client: Client::new(),
        config: Arc::new(AppConfig::load()),
        desktop_avatar_streams: Arc::new(Mutex::new(HashMap::new())),
        last_tts_text_by_request: Arc::new(Mutex::new(HashMap::new())),
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
            window_toggle_expanded,
            window_resize,
            window_start_drag,
            window_set_click_through,
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
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_always_on_top(true);
            let _ = window.set_position(Position::Logical(LogicalPosition::new(64.0, 280.0)));

            // --- System tray ---
            let show_hide_label = ui_text("tray.showHide");
            let show_hide = MenuItemBuilder::with_id("show_hide", &show_hide_label).build(app)?;

            // Size submenu
            let size_collapsed_label = ui_text("tray.sizeCollapsed");
            let size_collapsed = MenuItemBuilder::with_id("size_collapsed", &size_collapsed_label)
                .build(app)?;
            let size_expanded_label = ui_text("tray.sizeExpanded");
            let size_expanded =
                MenuItemBuilder::with_id("size_expanded", &size_expanded_label).build(app)?;
            let size_label = ui_text("tray.size");
            let size_submenu = SubmenuBuilder::with_id(app, "size", &size_label)
                .item(&size_collapsed)
                .item(&size_expanded)
                .build()?;

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
                .item(&PredefinedMenuItem::separator(app)?)
                .item(&size_submenu)
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
                                }
                            }
                        }
                        "size_collapsed" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ =
                                    resize_window_internal(&win, COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
                            }
                        }
                        "size_expanded" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ =
                                    resize_window_internal(&win, EXPANDED_WIDTH, EXPANDED_HEIGHT);
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
