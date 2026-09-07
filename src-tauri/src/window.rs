//! Native window geometry, persistence and Peek transitions.

use super::*;

#[tauri::command]
pub(super) async fn window_resize(
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
pub(super) struct WindowGeometry {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
    pub(super) screen_width: f64,
    pub(super) screen_height: f64,
}

#[tauri::command]
pub(super) async fn window_get_geometry(window: WebviewWindow) -> Result<WindowGeometry, String> {
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
pub(super) async fn window_start_drag(
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
pub(super) struct WindowRect {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

pub(super) fn ease_out_cubic(value: f64) -> f64 {
    1.0 - (1.0 - value).powi(3)
}

pub(super) fn rect_origin_delta(a: WindowRect, b: WindowRect) -> f64 {
    (a.x - b.x).abs().max((a.y - b.y).abs())
}

pub(super) fn current_window_rect(window: &WebviewWindow) -> Result<WindowRect, String> {
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

pub(super) fn read_persisted_window_state(path: &Path) -> PersistedWindowState {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<PersistedWindowState>(&raw).ok())
        .unwrap_or_default()
}

pub(super) fn write_persisted_window_state(path: &Path, value: &PersistedWindowState) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(parent);
    let Ok(serialized) = serde_json::to_string_pretty(value) else {
        return;
    };
    let _ = fs::write(path, serialized);
}

pub(super) fn startup_peek_origin(state: &PersistedWindowState) -> Option<(f64, f64)> {
    state.last_peek_rect.map(|rect| (rect.x, rect.y))
}

pub(super) async fn persist_window_state(state: &AppState) {
    let snapshot = PersistedWindowState {
        peek_position: *state.peek_position.lock().await,
        peek_size: *state.peek_size.lock().await,
        last_peek_rect: *state.last_peek_rect.lock().await,
        last_expanded_rect: *state.last_expanded_rect.lock().await,
    };
    write_persisted_window_state(&state.config.window_state_path, &snapshot);
}

pub(super) fn apply_window_rect(window: &WebviewWindow, rect: WindowRect) -> Result<(), String> {
    window
        .set_size(Size::Logical(LogicalSize::new(rect.width, rect.height)))
        .map_err(|error| error.to_string())?;
    window
        .set_position(Position::Logical(LogicalPosition::new(rect.x, rect.y)))
        .map_err(|error| error.to_string())
}

pub(super) fn monitor_logical_size(window: &WebviewWindow) -> Result<(f64, f64), String> {
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

pub(super) fn normalize_peek_size(width: f64, height: f64) -> WindowSize {
    let diameter = width
        .min(height)
        .clamp(150.0, MAX_PEEK_WIDTH.min(MAX_PEEK_HEIGHT));
    WindowSize {
        width: diameter,
        height: diameter,
    }
}

pub(super) fn clamp_window_rect_to_monitor(
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

pub(super) fn peek_rect_for_position(
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

pub(super) fn peek_rect_for_origin(
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

pub(super) fn expanded_rect_for_position(
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

pub(super) fn expanded_rect_for_origin(
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

pub(super) async fn animate_window_rect(
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
pub(super) async fn window_set_peek_position(
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
pub(super) async fn window_set_peek_mode(
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
        if window.show().is_ok() {
            let _ = window.emit("avatar-window-visibility", true);
        }
    }
    persist_window_state(state.inner()).await;
    Ok(())
}

pub(super) fn resize_window_internal(
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

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum WindowResizeAnchor {
    Left,
    Right,
}
