import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AVATAR_CAMERA_CONFIG,
  formatAvatarCameraConfig,
  type AvatarCameraConfig
} from "./lib/avatar-stage-config";
import { getWindowSizesForPreset } from "./lib/window-presets";
import { ChatPanel } from "./components/ChatPanel";
import { AvatarStage } from "./components/AvatarStage";
import { DataPanelSlider } from "./components/DataPanelSlider";
import { DemoDataTable } from "./components/DataTable";
import { DesktopAvatarWidgetPanel } from "./components/DesktopAvatarWidgetPanel";
import { DemoKpiCard } from "./components/KpiCard";
import { SpeechBubble } from "./components/SpeechBubble";
import { useDesktopCompanion } from "./hooks/useDesktopCompanion";

export default function App() {
  const companion = useDesktopCompanion();
  const [showDemo, setShowDemo] = useState(false);
  const [animationNames, setAnimationNames] = useState<string[]>([]);
  const [cameraConfig, setCameraConfig] = useState<AvatarCameraConfig>(
    DEFAULT_AVATAR_CAMERA_CONFIG
  );
  const [forcedAnimation, setForcedAnimation] = useState<string | null>(null);

  const bottomStackRef = useRef<HTMLDivElement>(null);
  // Approximate height the bottom stack occupies when only the launcher is shown
  const baseBottomHeight = 60;
  // Bottom offset (px) used to float the data panel just above the chat panel
  const stackBottomMargin = 26; // matches .bottom-stack { bottom: 26px }
  const dataPanelGap = 8;
  const [dataPanelBottom, setDataPanelBottom] = useState(90);

  const handleAnimationsLoaded = useCallback((names: string[]) => {
    setAnimationNames(names);
  }, []);

  const lastResizedHeight = useRef(0);

  // Dynamically resize window to fit the bottom stack content,
  // and keep the data panel anchored just above the chat panel.
  const syncWindowHeight = useCallback(() => {
    const el = bottomStackRef.current;
    if (!el) return;
    const stackHeight = el.scrollHeight;
    // Float data panel just above the bottom stack
    setDataPanelBottom(stackHeight + stackBottomMargin + dataPanelGap);
    const preset = getWindowSizesForPreset(companion.sizePreset);
    const baseSize = companion.isExpanded ? preset.expanded : preset.collapsed;
    // The base window height already accounts for the default chat bar (~baseBottomHeight).
    // We only add the *extra* pixels the stack needs beyond that default.
    const extra = Math.max(0, stackHeight - baseBottomHeight);
    const targetHeight = baseSize.height + extra;
    // Avoid redundant resizes
    if (Math.abs(targetHeight - lastResizedHeight.current) < 2) return;
    lastResizedHeight.current = targetHeight;
    void companion.resizeWindow(baseSize.width, targetHeight);
  }, [companion.sizePreset, companion.isExpanded]);

  // Observe the bottom stack for size changes and auto-resize window
  useEffect(() => {
    const el = bottomStackRef.current;
    if (!el) return;
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => syncWindowHeight());
    });
    observer.observe(el);
    // Initial measurement
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
    (companion.isExpanded ? "Ask me anything. I can stay local or check live business data." : "");
  const bubbleTone = companion.error
    ? "error"
    : companion.status && companion.companionState !== "idle"
      ? "status"
      : "default";
  const activeWidget = latestAssistantMessage?.widget ?? null;
  const cameraConfigSnippet = formatAvatarCameraConfig(cameraConfig);

  const adjustWindowHeight = useCallback(
    (delta: number) => {
      const nextHeight = Math.max(480, companion.windowSize.height + delta);
      lastResizedHeight.current = nextHeight;
      void companion.resizeWindow(companion.windowSize.width, nextHeight);
    },
    [companion]
  );

  return (
    <main className={`app-shell ${companion.isExpanded ? "is-expanded" : "is-collapsed"}`}>
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
      />

      {showDemo ? (
        <div className="data-panel" style={{ bottom: dataPanelBottom }}>
          <DataPanelSlider onClose={() => setShowDemo(false)}>
            <DemoDataTable onClose={() => setShowDemo(false)} />
            <DemoKpiCard onClose={() => setShowDemo(false)} />
          </DataPanelSlider>
        </div>
      ) : activeWidget ? (
        <div className="data-panel" style={{ bottom: dataPanelBottom }}>
          <DesktopAvatarWidgetPanel
            widget={activeWidget}
            followUpQuestions={latestAssistantMessage?.followUpQuestions}
            onSuggestionSelect={companion.submitSuggestion}
          />
        </div>
      ) : null}

      <div className="bottom-stack" ref={bottomStackRef}>
        <ChatPanel
          draft={companion.draft}
          error={companion.error}
          isExpanded={companion.isExpanded}
          isRecording={companion.isRecording}
          sizePreset={companion.sizePreset}
          ttsEnabled={companion.ttsEnabled}
          animationNames={animationNames}
          cameraConfig={cameraConfig}
          cameraConfigSnippet={cameraConfigSnippet}
          forcedAnimation={forcedAnimation}
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
          onRetry={companion.retryLastPrompt}
          onDragStart={companion.startWindowDrag}
          onToggleDemo={() => setShowDemo((v) => !v)}
          onSelectAnimation={setForcedAnimation}
        />
      </div>
    </main>
  );
}
