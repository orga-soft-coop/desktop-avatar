//! Tenant-bound request, HITL and radar commands and streams.

use super::*;

#[tauri::command]
pub(super) async fn desktop_avatar_request_create(
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
pub(super) async fn desktop_avatar_request_get(
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
        (Some(request_id), None) => desktop_avatar_resource_path(
            &["v1", "desktop-avatar", "requests", request_id.as_str()],
            &[],
        )?,
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
pub(super) async fn desktop_avatar_clarification_reply(
    state: State<'_, AppState>,
    avatar_request_id: String,
    clarification_id: String,
    request: ReplyDesktopAvatarClarificationInput,
    expected_context_id: String,
) -> Result<CreateDesktopAvatarRequestResult, String> {
    let avatar_request_id = avatar_request_id.trim();
    let clarification_id = clarification_id.trim();
    if avatar_request_id.is_empty() || clarification_id.is_empty() {
        return Err("avatarRequestId and clarificationId are required.".to_string());
    }
    if request.client_request_id.trim().is_empty() || request.answer.trim().is_empty() {
        return Err("clientRequestId and answer are required.".to_string());
    }

    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = desktop_avatar_resource_path(
        &[
            "v1",
            "desktop-avatar",
            "requests",
            avatar_request_id,
            "clarifications",
            clarification_id,
            "replies",
        ],
        &[],
    )?;
    let result = execution
        .api
        .post_json::<_, CreateDesktopAvatarRequestResult>(&url, &request)
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
pub(super) async fn desktop_avatar_dataset_page_get(
    state: State<'_, AppState>,
    avatar_request_id: String,
    result_id: String,
    cursor: Option<String>,
    expected_context_id: String,
) -> Result<DesktopAvatarDatasetPage, String> {
    let avatar_request_id = avatar_request_id.trim();
    let result_id = result_id.trim();
    if avatar_request_id.is_empty() || result_id.is_empty() {
        return Err("avatarRequestId and resultId are required.".to_string());
    }

    let cursor = cursor
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let query = cursor
        .map(|value| vec![("cursor", value)])
        .unwrap_or_default();
    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = desktop_avatar_resource_path(
        &[
            "v1",
            "desktop-avatar",
            "requests",
            avatar_request_id,
            "results",
            result_id,
            "pages",
        ],
        query.as_slice(),
    )?;
    let page = execution
        .api
        .get_json::<DesktopAvatarDatasetPage>(&url)
        .await
        .map_err(|error| error.to_string())?;
    if !broker
        .is_current(&session.context_id, session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".to_string());
    }
    Ok(page)
}

#[tauri::command]
pub(super) async fn desktop_avatar_conversation_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
    expected_context_id: String,
) -> Result<DesktopAvatarConversationCancelResult, String> {
    let conversation_id = conversation_id.trim();
    if conversation_id.is_empty() {
        return Err("conversationId is required.".to_string());
    }

    let broker = agent_studio_broker(state.inner()).map_err(|error| error.to_string())?;
    let execution = broker
        .require_execution_context(&expected_context_id)
        .await
        .map_err(|error| error.to_string())?;
    let session = execution.session;
    let url = desktop_avatar_resource_path(
        &[
            "v1",
            "desktop-avatar",
            "conversations",
            conversation_id,
            "cancel",
        ],
        &[],
    )?;
    let result = execution
        .api
        .post_empty::<DesktopAvatarConversationCancelResult>(&url)
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
pub(super) async fn desktop_avatar_radar_get(
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
pub(super) async fn desktop_avatar_radar_stream_start(
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
pub(super) async fn desktop_avatar_radar_stream_stop(
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
pub(super) async fn desktop_avatar_request_stream(
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
        None => desktop_avatar_resource_path(
            &[
                "v1",
                "desktop-avatar",
                "requests",
                request_id.as_str(),
                "stream",
            ],
            &[],
        )?,
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
pub(super) async fn desktop_avatar_request_stream_stop(
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
pub(super) async fn hitl_decision_stream_start(
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
pub(super) async fn hitl_decision_stream_stop(
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

pub(super) fn hitl_idempotency_key(
    prefix: &str,
    run_id: &str,
    proposal_id: Option<&str>,
) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!(
        "desktop-avatar-{prefix}-{run_id}-{}-{millis}",
        proposal_id.unwrap_or("run")
    )
}

pub(super) async fn post_hitl_decision(
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
pub(super) async fn hitl_decision_approve(
    state: State<'_, AppState>,
    input: HitlDecisionInput,
    expected_context_id: String,
) -> Result<(), String> {
    post_hitl_decision(state, input, true, &expected_context_id).await
}

#[tauri::command]
pub(super) async fn hitl_decision_reject(
    state: State<'_, AppState>,
    input: HitlDecisionInput,
    expected_context_id: String,
) -> Result<(), String> {
    post_hitl_decision(state, input, false, &expected_context_id).await
}

#[tauri::command]
pub(super) async fn hitl_request_more_info(
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

pub(super) async fn process_desktop_avatar_stream(
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

pub(super) async fn process_hitl_decision_stream(
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

pub(super) async fn process_desktop_avatar_radar_stream(
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

pub(super) async fn ensure_stream_current(
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

pub(super) fn context_bound_payload(context_id: &str, mut payload: Value) -> Value {
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

pub(super) fn emit_desktop_avatar_stream_event(
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

pub(super) fn emit_desktop_avatar_stream_lifecycle(
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

pub(super) fn emit_hitl_decision_stream_event(
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

pub(super) fn emit_desktop_avatar_radar_stream_event(
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

pub(super) fn emit_desktop_avatar_radar_stream_lifecycle(
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

pub(super) fn emit_hitl_decision_stream_lifecycle(
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
