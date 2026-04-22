import { useState } from "react";
import type { AvatarCameraConfig } from "../lib/avatar-stage-config";
import type { DevToolsLatencySnapshot } from "../lib/contracts";
import { t } from "../lib/i18n";
import { SIZE_PRESET_OPTIONS, type SizePreset } from "../lib/window-presets";

interface ChatPanelProps {
  draft: string;
  isExpanded: boolean;
  isRecording: boolean;
  sizePreset: SizePreset;
  ttsEnabled: boolean;
  ttsVoices?: string[];
  selectedTtsVoice?: string | null;
  latencyDebug?: DevToolsLatencySnapshot | null;
  error?: string | null;
  animationNames?: string[];
  cameraConfig?: AvatarCameraConfig;
  cameraConfigSnippet?: string;
  forcedAnimation?: string | null;
  avatarAssetKind?: "legacy-vrm" | "packed-glb" | null;
  selectedAnimationClip?: string | null;
  resolvedAnimationMapping?: Record<string, string> | null;
  windowSize?: { width: number; height: number };
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onAdjustWindowHeight?: (delta: number) => void;
  onCameraConfigChange?: (next: AvatarCameraConfig) => void;
  onResetCameraConfig?: () => void;
  onToggleExpanded: () => void;
  onToggleTts: () => void;
  onSelectTtsVoice?: (voice: string | null) => void;
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
  ttsVoices,
  selectedTtsVoice,
  latencyDebug,
  error,
  animationNames,
  cameraConfig,
  cameraConfigSnippet,
  forcedAnimation,
  avatarAssetKind,
  selectedAnimationClip,
  resolvedAnimationMapping,
  windowSize,
  onDraftChange,
  onSubmit,
  onAdjustWindowHeight,
  onCameraConfigChange,
  onResetCameraConfig,
  onToggleExpanded,
  onToggleTts,
  onSelectTtsVoice,
  onToggleRecording,
  onSelectSizePreset,
  onRetry,
  onDragStart,
  onToggleDemo,
  onSelectAnimation
}: ChatPanelProps) {
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(true);
  const [configCopied, setConfigCopied] = useState(false);

  const hasDevTools = !!(
    onSelectAnimation ||
    onToggleDemo ||
    onAdjustWindowHeight ||
    onCameraConfigChange ||
    (onSelectTtsVoice && (ttsVoices?.length ?? 0) > 0) ||
    Boolean(latencyDebug)
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

  const handleCopyConfig = () => {
    if (!cameraConfigSnippet) return;
    navigator.clipboard.writeText(cameraConfigSnippet).then(() => {
      setConfigCopied(true);
      setTimeout(() => setConfigCopied(false), 1500);
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

  const formatLatency = (value: number | null): string => {
    if (typeof value !== "number") {
      return "—";
    }
    return `${value} ms`;
  };

  const formatTimestamp = (isoValue: string): string => {
    const date = new Date(isoValue);
    if (Number.isNaN(date.getTime())) {
      return isoValue;
    }
    return date.toLocaleTimeString();
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
              <button type="button" onClick={onRetry} title={t("chat.retry")}>
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
              placeholder={t("chat.placeholder")}
              autoFocus
            />
            <button className="chat-panel__send" type="button" onClick={onSubmit} title={t("chat.send")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>

          <div className="chat-panel__bar">
            <small className="chat-panel__hint">{t("chat.launcherHint")}</small>

            <div className="chat-panel__actions">
              <button type="button" onClick={onToggleRecording} title={isRecording ? t("chat.stopRecording") : t("chat.voiceInput")} className={isRecording ? "is-active" : undefined}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              </button>
              <button type="button" onClick={onToggleTts} title={ttsEnabled ? t("chat.muteTts") : t("chat.enableTts")} className={ttsEnabled ? "is-active" : undefined}>
                {ttsEnabled ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                )}
              </button>
              <button type="button" onClick={onToggleExpanded} title={t("chat.closeChat")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
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
                <span>{t("devTools.title")}</span>
                <svg className="chat-panel__devtools-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>

              {devToolsOpen ? (
                <div className="chat-panel__devtools-body">
                  {/* --- Demo toggle (top) --- */}
                  {onToggleDemo ? (
                    <div className="chat-panel__devtools-row">
                      <label>{t("devTools.demo")}</label>
                      <button className="chat-panel__devtools-btn chat-panel__devtools-btn--wide" type="button" onClick={onToggleDemo}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
                        <span>{t("devTools.showDemoComponents")}</span>
                      </button>
                    </div>
                  ) : null}

                  {onSelectTtsVoice && ttsVoices && ttsVoices.length > 0 ? (
                    <div className="chat-panel__devtools-row">
                      <label>{t("devTools.voice")}</label>
                      <select
                        value={selectedTtsVoice ?? ""}
                        onChange={(event) => onSelectTtsVoice(event.target.value || null)}
                      >
                        <option value="">{t("devTools.systemDefault")}</option>
                        {ttsVoices.map((voice) => (
                          <option key={voice} value={voice}>
                            {voice}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {latencyDebug ? (
                    <div className="chat-panel__devtools-section">
                      <div className="chat-panel__devtools-section-title">{t("devTools.latency")}</div>
                      <div className="chat-panel__devtools-kv">
                        <span className="chat-panel__devtools-k">{t("devTools.started")}</span>
                        <span className="chat-panel__devtools-v">{formatTimestamp(latencyDebug.startedAt)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.mode")}</span>
                        <span className="chat-panel__devtools-v">{latencyDebug.requestKind}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.route")}</span>
                        <span className="chat-panel__devtools-v">{latencyDebug.route}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.status")}</span>
                        <span className="chat-panel__devtools-v">{latencyDebug.status ?? "—"}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.create")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.createAcceptedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.stream")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.streamConnectedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.firstEvent")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.firstEventMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.firstResponse")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.firstResponseMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.polling")}</span>
                        <span className="chat-panel__devtools-v">
                          {latencyDebug.usedPolling
                            ? formatLatency(latencyDebug.pollFallbackMs)
                            : t("devTools.no")}
                        </span>
                        <span className="chat-panel__devtools-k">{t("devTools.completed")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.completedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.failed")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.failedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.ttsRequest")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.ttsRequestedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.ttsStart")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.ttsStartedMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.talkToTts")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.talkToTtsStartMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.ttsDuration")}</span>
                        <span className="chat-panel__devtools-v">{formatLatency(latencyDebug.ttsSpeakDurationMs)}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.ttsProvider")}</span>
                        <span className="chat-panel__devtools-v">{latencyDebug.ttsProvider ?? "—"}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.ttsFallback")}</span>
                        <span className="chat-panel__devtools-v">
                          {latencyDebug.ttsFallbackUsed === null
                            ? "—"
                            : latencyDebug.ttsFallbackUsed
                              ? t("devTools.yes")
                              : t("devTools.no")}
                        </span>
                        {latencyDebug.lastError ? (
                          <>
                            <span className="chat-panel__devtools-k">{t("devTools.error")}</span>
                            <span className="chat-panel__devtools-v chat-panel__devtools-v--error">{latencyDebug.lastError}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {/* --- Animation picker --- */}
                  {onSelectAnimation && animationNames && animationNames.length > 0 ? (
                    <div className="chat-panel__devtools-row">
                      <label>{t("devTools.animation")}</label>
                      <select
                        value={forcedAnimation ?? ""}
                        onChange={(e) => onSelectAnimation(e.target.value || null)}
                      >
                        <option value="">{t("devTools.autoStateBased")}</option>
                        {animationNames.map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {avatarAssetKind || selectedAnimationClip || resolvedAnimationMapping ? (
                    <div className="chat-panel__devtools-section">
                      <div className="chat-panel__devtools-section-title">{t("devTools.avatarRuntime")}</div>
                      <div className="chat-panel__devtools-kv">
                        <span className="chat-panel__devtools-k">{t("devTools.asset")}</span>
                        <span className="chat-panel__devtools-v">{avatarAssetKind ?? "—"}</span>
                        <span className="chat-panel__devtools-k">{t("devTools.clip")}</span>
                        <span className="chat-panel__devtools-v">
                          {selectedAnimationClip ?? "—"}
                        </span>
                      </div>
                      {resolvedAnimationMapping &&
                      Object.keys(resolvedAnimationMapping).length > 0 ? (
                        <pre className="chat-panel__devtools-mapping">
                          {Object.entries(resolvedAnimationMapping)
                            .map(([state, clip]) => `${state} -> ${clip}`)
                            .join("\n")}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}

                  {/* --- Window section --- */}
                  <div className="chat-panel__devtools-section">
                    <div className="chat-panel__devtools-section-title">{t("devTools.window")}</div>

                    <div className="chat-panel__devtools-row">
                      <label>{t("devTools.preset")}</label>
                      <div className="chat-panel__size-presets">
                        {SIZE_PRESET_OPTIONS.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={preset.id === sizePreset ? "is-active" : undefined}
                            onClick={() => onSelectSizePreset(preset.id)}
                            title={t("devTools.sizeTitle", { label: preset.label })}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {windowSize && onAdjustWindowHeight ? (
                      <div className="chat-panel__devtools-row">
                        <label>{t("devTools.height")}</label>
                        <div className="chat-panel__devtools-inline">
                          <button
                            className="chat-panel__devtools-btn"
                            type="button"
                            onClick={() => onAdjustWindowHeight(-40)}
                            title={t("devTools.shrinkWindow")}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            <span>40px</span>
                          </button>
                          <span className="chat-panel__devtools-metric">
                            {Math.round(windowSize.width)} &times; {Math.round(windowSize.height)}
                          </span>
                          <button
                            className="chat-panel__devtools-btn"
                            type="button"
                            onClick={() => onAdjustWindowHeight(40)}
                            title={t("devTools.growWindow")}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            <span>40px</span>
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {/* --- Camera section (collapsible) --- */}
                  {cameraConfig && onCameraConfigChange ? (
                    <div className="chat-panel__devtools-section">
                      <button
                        className="chat-panel__devtools-section-toggle"
                        type="button"
                        onClick={() => setCameraOpen((v) => !v)}
                      >
                        <span>{t("devTools.camera")}</span>
                        <svg className={`chat-panel__devtools-section-chevron ${cameraOpen ? "is-open" : ""}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                      </button>

                      {cameraOpen ? (
                        <div className="chat-panel__devtools-section-body">
                          <div className="chat-panel__devtools-row">
                            <label>{t("devTools.position")}</label>
                            <div className="chat-panel__devtools-slider-group">
                              {(["x", "y", "z"] as const).map((axis) => (
                                <div className="chat-panel__devtools-slider-row" key={`pos-${axis}`}>
                                  <span className="chat-panel__devtools-axis">{axis.toUpperCase()}</span>
                                  <input
                                    type="range"
                                    min={axis === "y" ? "-1" : "-3"}
                                    max={axis === "z" ? "8" : "3"}
                                    step="0.05"
                                    value={cameraConfig.position[axis]}
                                    onChange={(e) => handleCameraNumberChange("position", axis, e.target.value)}
                                    aria-label={t("devTools.positionAxis", { axis: axis.toUpperCase() })}
                                  />
                                  <input
                                    className="chat-panel__devtools-num"
                                    type="number"
                                    step="0.05"
                                    value={cameraConfig.position[axis]}
                                    onChange={(e) => handleCameraNumberChange("position", axis, e.target.value)}
                                    aria-label={t("devTools.positionAxisValue", { axis: axis.toUpperCase() })}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="chat-panel__devtools-row">
                            <label>{t("devTools.target")}</label>
                            <div className="chat-panel__devtools-slider-group">
                              {(["x", "y", "z"] as const).map((axis) => (
                                <div className="chat-panel__devtools-slider-row" key={`tgt-${axis}`}>
                                  <span className="chat-panel__devtools-axis">{axis.toUpperCase()}</span>
                                  <input
                                    type="range"
                                    min="-3"
                                    max="3"
                                    step="0.05"
                                    value={cameraConfig.target[axis]}
                                    onChange={(e) => handleCameraNumberChange("target", axis, e.target.value)}
                                    aria-label={t("devTools.targetAxis", { axis: axis.toUpperCase() })}
                                  />
                                  <input
                                    className="chat-panel__devtools-num"
                                    type="number"
                                    step="0.05"
                                    value={cameraConfig.target[axis]}
                                    onChange={(e) => handleCameraNumberChange("target", axis, e.target.value)}
                                    aria-label={t("devTools.targetAxisValue", { axis: axis.toUpperCase() })}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="chat-panel__devtools-row">
                            <label>{t("devTools.fov")}</label>
                            <div className="chat-panel__devtools-slider-row">
                              <input
                                type="range"
                                min="10"
                                max="120"
                                step="1"
                                value={cameraConfig.fov}
                                onChange={(e) => handleCameraFovChange(e.target.value)}
                                aria-label={t("devTools.fieldOfView")}
                              />
                              <input
                                className="chat-panel__devtools-num"
                                type="number"
                                step="1"
                                value={cameraConfig.fov}
                                onChange={(e) => handleCameraFovChange(e.target.value)}
                                aria-label={t("devTools.fieldOfViewValue")}
                              />
                            </div>
                          </div>

                          <div className="chat-panel__devtools-row chat-panel__devtools-row--actions">
                            {onResetCameraConfig ? (
                              <button
                                className="chat-panel__devtools-btn"
                                type="button"
                                onClick={onResetCameraConfig}
                              >
                                {t("devTools.reset")}
                              </button>
                            ) : null}
                            {cameraConfigSnippet ? (
                              <button
                                className="chat-panel__devtools-btn"
                                type="button"
                                onClick={handleCopyConfig}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                                <span>{configCopied ? t("devTools.copied") : t("devTools.copyConfig")}</span>
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
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
          <span>{draft || t("chat.placeholder")}</span>
          <small>{t("chat.launcherHint")}</small>
        </button>
      )}
    </section>
  );
}
