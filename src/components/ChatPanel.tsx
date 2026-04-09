import { useState } from "react";
import type { AvatarCameraConfig } from "../lib/avatar-stage-config";
import { SIZE_PRESET_OPTIONS, type SizePreset } from "../lib/window-presets";

interface ChatPanelProps {
  draft: string;
  isExpanded: boolean;
  isRecording: boolean;
  sizePreset: SizePreset;
  ttsEnabled: boolean;
  error?: string | null;
  animationNames?: string[];
  cameraConfig?: AvatarCameraConfig;
  cameraConfigSnippet?: string;
  forcedAnimation?: string | null;
  windowSize?: { width: number; height: number };
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onAdjustWindowHeight?: (delta: number) => void;
  onCameraConfigChange?: (next: AvatarCameraConfig) => void;
  onResetCameraConfig?: () => void;
  onToggleExpanded: () => void;
  onToggleTts: () => void;
  onToggleRecording: () => void;
  onSelectSizePreset: (preset: SizePreset) => void;
  onRetry: () => void;
  onDragStart: () => void;
  onToggleDemo?: () => void;
  onSelectAnimation?: (name: string | null) => void;
}

export function ChatPanel({
  draft,
  isExpanded,
  isRecording,
  sizePreset,
  ttsEnabled,
  error,
  animationNames,
  cameraConfig,
  cameraConfigSnippet,
  forcedAnimation,
  windowSize,
  onDraftChange,
  onSubmit,
  onAdjustWindowHeight,
  onCameraConfigChange,
  onResetCameraConfig,
  onToggleExpanded,
  onToggleTts,
  onToggleRecording,
  onSelectSizePreset,
  onRetry,
  onDragStart,
  onToggleDemo,
  onSelectAnimation
}: ChatPanelProps) {
  const [devToolsOpen, setDevToolsOpen] = useState(false);

  const hasDevTools = !!(
    onSelectAnimation ||
    onToggleDemo ||
    onAdjustWindowHeight ||
    onCameraConfigChange
  );

  const handleCameraNumberChange = (
    section: keyof Pick<AvatarCameraConfig, "position" | "target">,
    axis: keyof AvatarCameraConfig["position"],
    value: string
  ) => {
    if (!cameraConfig || !onCameraConfigChange) {
      return;
    }

    const nextValue = Number.parseFloat(value);
    if (Number.isNaN(nextValue)) {
      return;
    }

    onCameraConfigChange({
      ...cameraConfig,
      [section]: {
        ...cameraConfig[section],
        [axis]: nextValue
      }
    });
  };

  const handleCameraFovChange = (value: string) => {
    if (!cameraConfig || !onCameraConfigChange) {
      return;
    }

    const nextValue = Number.parseFloat(value);
    if (Number.isNaN(nextValue)) {
      return;
    }

    onCameraConfigChange({
      ...cameraConfig,
      fov: nextValue
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
    if (event.key === "Escape") {
      onToggleExpanded();
    }
  };

  return (
    <section className={`chat-panel ${isExpanded ? "is-expanded" : "is-collapsed"}`}>
      {isExpanded ? (
        <div
          className="chat-panel__dock"
          data-tauri-drag-region
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button, input, select")) {
              return;
            }
            onDragStart();
          }}
        >
          {error ? (
            <div className="chat-panel__error">
              <span>{error}</span>
              <button type="button" onClick={onRetry} title="Retry">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              </button>
            </div>
          ) : null}

          <div className="chat-panel__composer">
            <input
              type="text"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask me anything..."
              autoFocus
            />
            <button className="chat-panel__send" type="button" onClick={onSubmit} title="Send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>

          <div className="chat-panel__bar">
            <div className="chat-panel__actions">
              <button type="button" onClick={onToggleRecording} title={isRecording ? "Stop recording" : "Voice input"} className={isRecording ? "is-active" : undefined}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>
              <button type="button" onClick={onToggleTts} title={ttsEnabled ? "Mute TTS" : "Enable TTS"} className={ttsEnabled ? "is-active" : undefined}>
                {ttsEnabled ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                )}
              </button>
              <button type="button" onClick={onToggleExpanded} title="Close chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            <small className="chat-panel__hint">↵ send · esc close</small>
          </div>

          {/* Collapsible dev tools drawer */}
          {hasDevTools ? (
            <div className={`chat-panel__devtools ${devToolsOpen ? "is-open" : ""}`}>
              <button
                className="chat-panel__devtools-toggle"
                type="button"
                onClick={() => setDevToolsOpen((v) => !v)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                <span>Dev Tools</span>
                <svg className="chat-panel__devtools-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>

              {devToolsOpen ? (
                <div className="chat-panel__devtools-body">
                  {/* Size presets */}
                  <div className="chat-panel__devtools-row">
                    <label>Size</label>
                    <div className="chat-panel__size-presets">
                      {SIZE_PRESET_OPTIONS.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={preset.id === sizePreset ? "is-active" : undefined}
                          onClick={() => onSelectSizePreset(preset.id)}
                          title={`Size ${preset.label}`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {windowSize && onAdjustWindowHeight ? (
                    <div className="chat-panel__devtools-row">
                      <label>Win</label>
                      <div className="chat-panel__devtools-inline">
                        <button
                          className="chat-panel__devtools-btn"
                          type="button"
                          onClick={() => onAdjustWindowHeight(-40)}
                        >
                          -40h
                        </button>
                        <span className="chat-panel__devtools-metric">
                          {Math.round(windowSize.width)} x {Math.round(windowSize.height)}
                        </span>
                        <button
                          className="chat-panel__devtools-btn"
                          type="button"
                          onClick={() => onAdjustWindowHeight(40)}
                        >
                          +40h
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {/* Animation picker */}
                  {onSelectAnimation && animationNames && animationNames.length > 0 ? (
                    <div className="chat-panel__devtools-row">
                      <label>Anim</label>
                      <select
                        value={forcedAnimation ?? ""}
                        onChange={(e) => onSelectAnimation(e.target.value || null)}
                      >
                        <option value="">Auto (state-based)</option>
                        {animationNames.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {cameraConfig && onCameraConfigChange ? (
                    <>
                      <div className="chat-panel__devtools-row chat-panel__devtools-row--top">
                        <label>Cam</label>
                        <div className="chat-panel__devtools-grid">
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.position.x}
                            onChange={(event) =>
                              handleCameraNumberChange("position", "x", event.target.value)
                            }
                            aria-label="Camera X"
                          />
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.position.y}
                            onChange={(event) =>
                              handleCameraNumberChange("position", "y", event.target.value)
                            }
                            aria-label="Camera Y"
                          />
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.position.z}
                            onChange={(event) =>
                              handleCameraNumberChange("position", "z", event.target.value)
                            }
                            aria-label="Camera Z"
                          />
                        </div>
                      </div>

                      <div className="chat-panel__devtools-row chat-panel__devtools-row--top">
                        <label>Aim</label>
                        <div className="chat-panel__devtools-grid">
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.target.x}
                            onChange={(event) =>
                              handleCameraNumberChange("target", "x", event.target.value)
                            }
                            aria-label="Target X"
                          />
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.target.y}
                            onChange={(event) =>
                              handleCameraNumberChange("target", "y", event.target.value)
                            }
                            aria-label="Target Y"
                          />
                          <input
                            type="number"
                            step="0.05"
                            value={cameraConfig.target.z}
                            onChange={(event) =>
                              handleCameraNumberChange("target", "z", event.target.value)
                            }
                            aria-label="Target Z"
                          />
                        </div>
                      </div>

                      <div className="chat-panel__devtools-row">
                        <label>FOV</label>
                        <div className="chat-panel__devtools-inline">
                          <input
                            className="chat-panel__devtools-input"
                            type="number"
                            step="1"
                            value={cameraConfig.fov}
                            onChange={(event) => handleCameraFovChange(event.target.value)}
                            aria-label="Camera field of view"
                          />
                          {onResetCameraConfig ? (
                            <button
                              className="chat-panel__devtools-btn"
                              type="button"
                              onClick={onResetCameraConfig}
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {cameraConfigSnippet ? (
                        <div className="chat-panel__devtools-snippet">
                          <label>Cfg</label>
                          <textarea readOnly value={cameraConfigSnippet} />
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {/* Demo components toggle */}
                  {onToggleDemo ? (
                    <div className="chat-panel__devtools-row">
                      <label>Data</label>
                      <button className="chat-panel__devtools-btn" type="button" onClick={onToggleDemo}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                        <span>Show demo components</span>
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <button
          className="chat-panel__launcher"
          type="button"
          onClick={onToggleExpanded}
        >
          <span>{draft || "Ask me anything..."}</span>
          <small>↵ send · esc close</small>
        </button>
      )}
    </section>
  );
}
