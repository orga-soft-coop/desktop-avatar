import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AVATAR_CAMERA_CONFIG,
  formatAvatarCameraConfig,
  type AvatarCameraConfig
} from "./lib/avatar-stage-config";
import { MIN_CONTENT_WINDOW_HEIGHT } from "./lib/window-layout";
import { getWindowSizesForPreset } from "./lib/window-presets";
import { ChatPanel } from "./components/ChatPanel";
import { AvatarStage } from "./components/AvatarStage";
import { DesktopAvatarWidgetPanel } from "./components/DesktopAvatarWidgetPanel";
import { SpeechBubble } from "./components/SpeechBubble";
import { useDesktopCompanion } from "./hooks/useDesktopCompanion";
import { t } from "./lib/i18n";

const TEXT_WIDGET_BUBBLE_ONLY_MAX_CHARS = 220;

export default function App() {
  const companion = useDesktopCompanion();
  const [dismissedWidgetMessageIds, setDismissedWidgetMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const [animationNames, setAnimationNames] = useState<string[]>([]);
  const [cameraConfig, setCameraConfig] = useState<AvatarCameraConfig>(
    DEFAULT_AVATAR_CAMERA_CONFIG
  );
  const [forcedAnimation, setForcedAnimation] = useState<string | null>(null);
  const [avatarDebug, setAvatarDebug] = useState<{
    assetKind: "legacy-vrm" | "packed-glb" | null;
    selectedClip: string | null;
    resolvedAnimationMapping: Record<string, string>;
  }>({
    assetKind: null,
    selectedClip: null,
    resolvedAnimationMapping: {}
  });

  const appShellRef = useRef<HTMLElement>(null);

  const handleAnimationsLoaded = useCallback((names: string[]) => {
    setAnimationNames(names);
  }, []);

  const lastResizedHeight = useRef(0);
  const resizeWindowRef = useRef(companion.resizeWindow);
  resizeWindowRef.current = companion.resizeWindow;

  // Fit the native window to the measured layout (avatar + optional data panel + chat).
  const syncWindowHeight = useCallback(() => {
    const shell = appShellRef.current;
    if (!shell) return;

    const preset = getWindowSizesForPreset(companion.sizePreset);
    const baseSize = companion.isExpanded ? preset.expanded : preset.collapsed;
    const measured = Math.ceil(
      Math.max(shell.scrollHeight, shell.getBoundingClientRect().height)
    );
    const targetHeight = Math.max(MIN_CONTENT_WINDOW_HEIGHT, measured);

    if (Math.abs(targetHeight - lastResizedHeight.current) < 2) return;
    lastResizedHeight.current = targetHeight;
    void resizeWindowRef.current(baseSize.width, targetHeight);
  }, [companion.isExpanded, companion.sizePreset]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => syncWindowHeight());
    });
    observer.observe(shell);
    syncWindowHeight();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [syncWindowHeight]);

  const latestAssistantMessage = [...companion.messages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.text.trim() || message.widget));
  const bubbleText =
    companion.error ??
    companion.status ??
    latestAssistantMessage?.text ??
    (companion.isExpanded ? t("app.defaultBubble") : "");
  const bubbleTone = companion.error
    ? "error"
    : companion.status && companion.companionState !== "idle"
      ? "status"
      : "default";
  const activeWidget = latestAssistantMessage?.widget ?? null;
  const bubbleOnlyTextWidget =
    activeWidget?.type === "text" &&
    activeWidget.text.trim().length > 0 &&
    activeWidget.text.trim().length <= TEXT_WIDGET_BUBBLE_ONLY_MAX_CHARS &&
    (latestAssistantMessage?.followUpQuestions?.length ?? 0) === 0;
  const panelWidget = bubbleOnlyTextWidget ? null : activeWidget;
  const panelWidgetMessageId = panelWidget ? (latestAssistantMessage?.id ?? null) : null;
  const panelWidgetDismissed =
    panelWidgetMessageId !== null && dismissedWidgetMessageIds.has(panelWidgetMessageId);
  const visiblePanelWidget = panelWidgetDismissed ? null : panelWidget;
  const cameraConfigSnippet = formatAvatarCameraConfig(cameraConfig);

  const dataPanelOpen = Boolean(visiblePanelWidget);
  useEffect(() => {
    const id = requestAnimationFrame(() => syncWindowHeight());
    return () => cancelAnimationFrame(id);
  }, [dataPanelOpen, syncWindowHeight]);

  const adjustWindowHeight = useCallback(
    (delta: number) => {
      const nextHeight = Math.max(MIN_CONTENT_WINDOW_HEIGHT, companion.windowSize.height + delta);
      lastResizedHeight.current = nextHeight;
      void companion.resizeWindow(companion.windowSize.width, nextHeight);
    },
    [companion]
  );

  const dismissWidgetPanel = useCallback(() => {
    if (!panelWidgetMessageId) {
      return;
    }
    setDismissedWidgetMessageIds((previous) => {
      if (previous.has(panelWidgetMessageId)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(panelWidgetMessageId);
      return next;
    });
  }, [panelWidgetMessageId]);

  return (
    <main
      ref={appShellRef}
      className={`app-shell ${companion.isExpanded ? "is-expanded" : "is-collapsed"}`}
    >
      <SpeechBubble
        text={bubbleText}
        tone={bubbleTone}
        onDragStart={companion.startWindowDrag}
      />

      <AvatarStage
        companionState={companion.companionState}
        expanded={companion.isExpanded}
        manifest={companion.avatarManifest}
        cameraConfig={cameraConfig}
        forcedAnimation={forcedAnimation}
        suggestedAnimation={companion.activeAnimation}
        onDragStart={companion.startWindowDrag}
        onAnimationsLoaded={handleAnimationsLoaded}
        onAnimationDebugChange={setAvatarDebug}
      />

      {visiblePanelWidget ? (
        <div className="data-panel">
          <DesktopAvatarWidgetPanel
            widget={visiblePanelWidget}
            followUpQuestions={latestAssistantMessage?.followUpQuestions}
            onSuggestionSelect={companion.submitSuggestion}
            onDismiss={dismissWidgetPanel}
          />
        </div>
      ) : null}

      <div className="bottom-stack">
        <ChatPanel
          draft={companion.draft}
          error={companion.error}
          isExpanded={companion.isExpanded}
          isRecording={companion.isRecording}
          sizePreset={companion.sizePreset}
          ttsEnabled={companion.ttsEnabled}
          ttsVoices={companion.ttsVoices}
          selectedTtsVoice={companion.selectedTtsVoice}
          latencyDebug={companion.latencyDebug}
          animationNames={animationNames}
          cameraConfig={cameraConfig}
          cameraConfigSnippet={cameraConfigSnippet}
          forcedAnimation={forcedAnimation}
          avatarAssetKind={avatarDebug.assetKind}
          selectedAnimationClip={avatarDebug.selectedClip}
          resolvedAnimationMapping={avatarDebug.resolvedAnimationMapping}
          windowSize={companion.windowSize}
          onDraftChange={companion.setDraft}
          onAdjustWindowHeight={adjustWindowHeight}
          onCameraConfigChange={setCameraConfig}
          onResetCameraConfig={() => setCameraConfig(DEFAULT_AVATAR_CAMERA_CONFIG)}
          onSelectSizePreset={companion.setSizePreset}
          onSubmit={companion.submitCurrentDraft}
          onToggleExpanded={companion.toggleExpanded}
          onToggleRecording={companion.toggleRecording}
          onToggleTts={companion.toggleTts}
          onSelectTtsVoice={companion.selectTtsVoice}
          onRetry={companion.retryLastPrompt}
          onDragStart={companion.startWindowDrag}
          onSelectAnimation={setForcedAnimation}
        />
      </div>
    </main>
  );
}
