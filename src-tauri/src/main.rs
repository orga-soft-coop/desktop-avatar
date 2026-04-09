use std::{
    env,
    fs,
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
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{
    async_runtime,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, State,
    WebviewWindow,
};
use tokio::process::Command;

const CHAT_STREAM_EVENT: &str = "chat-stream-event";
const TTS_STATE_EVENT: &str = "tts-state";
const COLLAPSED_WIDTH: f64 = 520.0;
const COLLAPSED_HEIGHT: f64 = 780.0;
const EXPANDED_WIDTH: f64 = 720.0;
const EXPANDED_HEIGHT: f64 = 920.0;

#[derive(Clone)]
struct AppState {
    client: Client,
    config: Arc<AppConfig>,
}

#[derive(Clone, Debug)]
struct AppConfig {
    comm_officer_base_url: Option<String>,
    comm_officer_token: Option<String>,
    openai_api_key: Option<String>,
    openai_stt_model: String,
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
    vrm_url: String,
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
            .or(default_manifest.exists().then_some(default_manifest.clone()));
        let log_file_path = workspace_root.join("tmp").join("desktop-avatar.log");

        let _ = fs::create_dir_all(log_file_path.parent().unwrap_or_else(|| Path::new(".")));
        let _ = fs::write(&log_file_path, "");

        Self {
            comm_officer_base_url: env::var("COMM_OFFICER_BASE_URL").ok(),
            comm_officer_token: env::var("COMM_OFFICER_TOKEN").ok(),
            openai_api_key: env::var("OPENAI_API_KEY").ok(),
            openai_stt_model: env::var("OPENAI_STT_MODEL")
                .unwrap_or_else(|_| "gpt-4o-mini-transcribe".to_string()),
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
                    "bootstrap: resolved vrm = {}, idle clips = {}",
                    manifest.vrm_url,
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
            append_log(&state.config.log_file_path, "bootstrap: no avatar manifest configured");
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
                    process_business_stream(window.clone(), request.request_id.clone(), response).await
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
async fn tts_speak(window: WebviewWindow, request_id: String, text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("say")
            .arg("-r")
            .arg("185")
            .arg(text)
            .spawn()
            .map_err(|error| error.to_string())?;

        emit_tts_state(&window, &request_id, true)?;
        let window_clone = window.clone();
        async_runtime::spawn(async move {
            let _ = child.wait().await;
            let _ = emit_tts_state(&window_clone, &request_id, false);
        });
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        emit_tts_state(&window, &request_id, false)?;
        Ok(())
    }
}

#[tauri::command]
async fn tts_stop(window: WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("killall").arg("say").spawn();
    }

    emit_tts_state(&window, "global", false)
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
        let text = response.text().await.unwrap_or_else(|_| "Unknown error".into());
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

async fn process_local_stream(
    window: WebviewWindow,
    request_id: String,
    response: reqwest::Response,
) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_else(|_| "Unknown error".into());
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

fn emit_tts_state(window: &WebviewWindow, request_id: &str, speaking: bool) -> Result<(), String> {
    window
        .emit(
            TTS_STATE_EVENT,
            TtsStateEvent {
                request_id: request_id.to_string(),
                speaking,
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
    manifest.vrm_url = resolve_manifest_asset_path(&manifest.vrm_url, base_dir);
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
    let response = response.error_for_status().map_err(|error| error.to_string())?;
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
    };

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
            chat_send_business,
            chat_send_local,
            speech_transcribe,
            tts_speak,
            tts_stop
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_always_on_top(true);
            let _ = window.set_position(Position::Logical(LogicalPosition::new(64.0, 280.0)));

            // --- System tray ---
            let show_hide =
                MenuItemBuilder::with_id("show_hide", "Show / Hide").build(app)?;

            // Size submenu
            let size_collapsed =
                MenuItemBuilder::with_id("size_collapsed", "Collapsed (520 x 780)").build(app)?;
            let size_expanded =
                MenuItemBuilder::with_id("size_expanded", "Expanded (720 x 920)").build(app)?;
            let size_submenu = SubmenuBuilder::with_id(app, "size", "Size")
                .item(&size_collapsed)
                .item(&size_expanded)
                .build()?;

            // TTS toggle
            let tts_toggle =
                MenuItemBuilder::with_id("tts_toggle", "Toggle TTS").build(app)?;

            // Always on top toggle
            let always_on_top =
                MenuItemBuilder::with_id("always_on_top", "Toggle Always on Top").build(app)?;

            // API URL display (informational + click to copy)
            let config = app.state::<AppState>();
            let llm_label = format!("LLM: {}", config.config.local_llm_base_url);
            let api_url_item =
                MenuItemBuilder::with_id("api_url", &llm_label).build(app)?;

            let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

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
                .icon(app.default_window_icon().unwrap().clone())
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
                                let _ = resize_window_internal(
                                    &win,
                                    COLLAPSED_WIDTH,
                                    COLLAPSED_HEIGHT,
                                );
                            }
                        }
                        "size_expanded" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = resize_window_internal(
                                    &win,
                                    EXPANDED_WIDTH,
                                    EXPANDED_HEIGHT,
                                );
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
        assert!(parser.push_line("data: {\"speechText\":\"Hallo\",").is_none());
        assert!(parser.push_line("data: \"displayText\":\"Hallo\"}").is_none());

        let frame = parser.push_line("").unwrap();
        assert_eq!(frame.event, "final");
        assert_eq!(frame.data(), "{\"speechText\":\"Hallo\",\n\"displayText\":\"Hallo\"}");
    }

    #[test]
    fn mime_type_mapping_supports_vrm_assets() {
        assert_eq!(mime_type_for_path("/tmp/avatar.vrm"), "model/gltf-binary");
        assert_eq!(mime_type_for_path("/tmp/idle.vrma"), "model/gltf-binary");
        assert_eq!(mime_type_for_path("/tmp/idle.fbx"), "application/octet-stream");
    }

    #[test]
    fn manifest_paths_are_resolved_against_manifest_directory() {
        let mut manifest = AvatarManifest {
            display_name: Some("Mint".to_string()),
            license: Some("CC0".to_string()),
            thumbnail_url: None,
            vrm_url: "./sample-assets/mint.vrm".to_string(),
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

        assert_eq!(manifest.vrm_url, "/tmp/avatar-config/./sample-assets/mint.vrm");
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
}
