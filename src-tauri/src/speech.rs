//! Transcription sessions, speech output and audio helpers.

use super::*;

#[tauri::command]
pub(super) async fn speech_transcribe(
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

pub(super) fn build_transcription_provider_chain(
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

pub(super) fn wrap_pcm16le_as_wav(bytes: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
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

pub(super) async fn transcribe_with_openai_file_api(
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

pub(super) fn emit_transcription_stream_event(
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

pub(super) fn emit_transcription_provider_changed(
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

pub(super) async fn transcribe_with_openai_realtime(
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
pub(super) async fn transcription_provider_get(
    state: State<'_, AppState>,
) -> Result<String, String> {
    let provider = *state.transcription_provider.lock().await;
    Ok(transcription_provider_label(provider).to_string())
}

#[tauri::command]
pub(super) async fn transcription_provider_set(
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
pub(super) async fn transcription_session_start(
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
pub(super) async fn transcription_session_append_audio(
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
pub(super) async fn transcription_session_commit_turn(
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
pub(super) async fn transcription_session_stop(
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
pub(super) async fn tts_list_voices(state: State<'_, AppState>) -> Result<Vec<String>, String> {
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
pub(super) async fn tts_speak(
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
pub(super) async fn list_system_tts_voices() -> Result<Vec<String>, String> {
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
pub(super) async fn list_system_tts_voices() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "macos")]
pub(super) fn ensure_tts_generation(
    state: &AppState,
    expected_generation: u64,
) -> Result<(), String> {
    if state.tts_generation.load(Ordering::SeqCst) == expected_generation {
        Ok(())
    } else {
        Err("DESKTOP_SESSION_CHANGED".to_string())
    }
}

#[cfg(target_os = "macos")]
pub(super) async fn spawn_tenant_tts_process(
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
pub(super) async fn speak_system_tts(
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
pub(super) async fn speak_local_tts(
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
pub(super) async fn speak_fish_tts(
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
pub(super) async fn speak_openai_tts(
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
pub(super) async fn speak_http_tts(
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
pub(super) async fn tts_stop(
    state: State<'_, AppState>,
    expected_context_id: String,
) -> Result<(), String> {
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

pub(super) fn emit_tts_state(
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

pub(super) async fn cancel_tts_processes(state: &AppState) {
    let handles = {
        let mut processes = state.tts_processes.lock().await;
        processes
            .drain()
            .map(|(_, handle)| handle)
            .collect::<Vec<_>>()
    };
    cancel_tts_process_handles(handles).await;
}

pub(super) async fn cancel_tts_process_handles(handles: Vec<TtsProcessHandle>) {
    for handle in handles {
        let _ = handle.cancel.send(());
        let _ = handle.stopped.await;
    }
}

pub(super) fn cleanup_tts_temp_files() {
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

pub(super) fn normalize_tts_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<&str>>().join(" ")
}

pub(super) fn local_tts_endpoint_candidates(raw_endpoint: &str) -> Vec<String> {
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

pub(super) fn truncate_for_log(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }

    value.chars().take(max_len).collect::<String>() + "…"
}

pub(super) fn should_skip_duplicate_tts_entry(
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

pub(super) fn default_local_tts_request_template(format: TtsHttpRequestFormat) -> Value {
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

pub(super) fn render_tts_request_template(
    template: &Value,
    input: &str,
    voice: &str,
    model: &str,
) -> Value {
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

pub(super) fn lookup_json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
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

pub(super) fn decode_json_tts_audio(
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

pub(super) fn mime_extension(mime: &str) -> &'static str {
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

pub(super) fn normalize_audio_mime_for_transcription(mime: &str) -> String {
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

pub(super) fn audio_file_extension_from_content_type(content_type: Option<&str>) -> &'static str {
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

pub(super) fn normalize_language_code(value: &str) -> Option<String> {
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

pub(super) fn resolve_transcription_language(request_locale: Option<&str>) -> Option<String> {
    request_locale
        .and_then(normalize_language_code)
        .or_else(|| {
            env::var("LANG")
                .ok()
                .and_then(|value| normalize_language_code(&value))
        })
        .or_else(|| Some("de".to_string()))
}
