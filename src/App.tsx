import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_AVATAR_CAMERA_CONFIG,
  formatAvatarCameraConfig,
  type AvatarCameraConfig
} from "./lib/avatar-stage-config";
import { MIN_CONTENT_WINDOW_HEIGHT } from "./lib/window-layout";
import { getWindowSizesForPreset } from "./lib/window-presets";
import { ChatPanel, type DevToolsDemoWidgetKind } from "./components/ChatPanel";
import { AvatarStage } from "./components/AvatarStage";
import { DataPanelSlider } from "./components/DataPanelSlider";
import { DesktopAvatarWidgetPanel } from "./components/DesktopAvatarWidgetPanel";
import { SpeechBubble } from "./components/SpeechBubble";
import { useDesktopCompanion } from "./hooks/useDesktopCompanion";
import type { DesktopAvatarWidgetPayload } from "./lib/contracts";
import { t } from "./lib/i18n";

const TEXT_WIDGET_BUBBLE_ONLY_MAX_CHARS = 220;

interface PanelEntry {
  id: string;
  source: "request" | "demo";
  messageId?: string;
  demoKind?: DevToolsDemoWidgetKind;
  widget: DesktopAvatarWidgetPayload;
  followUpQuestions: string[];
}

export default function App() {
  const companion = useDesktopCompanion();
  const [dismissedWidgetMessageIds, setDismissedWidgetMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const [activeDemoWidgets, setActiveDemoWidgets] = useState<DevToolsDemoWidgetKind[]>([]);
  const [activePanelEntryId, setActivePanelEntryId] = useState<string | null>(null);
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
  const defaultBubbleText = companion.isExpanded ? t("app.defaultBubble") : "";
  const latestWidgetMessageId = latestAssistantMessage?.widget ? latestAssistantMessage.id : null;
  const latestWidgetDismissed =
    latestWidgetMessageId !== null && dismissedWidgetMessageIds.has(latestWidgetMessageId);
  const resetBubbleToDefault =
    latestWidgetDismissed && !companion.error && !companion.status;
  const bubbleText =
    companion.error ??
    companion.status ??
    (resetBubbleToDefault ? defaultBubbleText : latestAssistantMessage?.text) ??
    defaultBubbleText;
  const bubbleTone = companion.error
    ? "error"
    : companion.status && companion.companionState !== "idle"
      ? "status"
      : "default";
  const showThinkingIndicator = companion.companionState === "thinking" && !companion.error;
  const demoWidgets = activeDemoWidgets
    .map((kind) => ({ kind, widget: buildDemoWidget(kind) }))
    .filter((entry): entry is { kind: DevToolsDemoWidgetKind; widget: DesktopAvatarWidgetPayload } =>
      entry.widget !== null
    );
  const requestPanelEntries: PanelEntry[] = companion.messages.reduce<PanelEntry[]>(
    (entries, message) => {
      if (message.role !== "assistant" || !message.widget) {
        return entries;
      }

      const widget = message.widget;
      const hideShortTextWidget =
        widget.type === "text" &&
        widget.text.trim().length > 0 &&
        widget.text.trim().length <= TEXT_WIDGET_BUBBLE_ONLY_MAX_CHARS &&
        (message.followUpQuestions?.length ?? 0) === 0;
      if (hideShortTextWidget || dismissedWidgetMessageIds.has(message.id)) {
        return entries;
      }

      entries.push({
        id: `request:${message.id}`,
        source: "request",
        messageId: message.id,
        widget,
        followUpQuestions: message.followUpQuestions ?? []
      });
      return entries;
    },
    []
  );

  const demoPanelEntries: PanelEntry[] = demoWidgets.map((entry) => ({
    id: `demo:${entry.kind}`,
    source: "demo",
    demoKind: entry.kind,
    widget: entry.widget,
    followUpQuestions: demoFollowUpQuestions(entry.widget)
  }));

  const panelEntries: PanelEntry[] = [...requestPanelEntries, ...demoPanelEntries];
  const activePanelIndex = panelEntries.findIndex((entry) => entry.id === activePanelEntryId);
  const activePanelEntry = activePanelIndex >= 0 ? panelEntries[activePanelIndex] : null;
  const visiblePanelWidget = activePanelEntry?.widget ?? null;
  const cameraConfigSnippet = formatAvatarCameraConfig(cameraConfig);

  const dataPanelOpen = Boolean(visiblePanelWidget);
  useEffect(() => {
    if (panelEntries.length === 0) {
      setActivePanelEntryId(null);
      return;
    }
    if (!activePanelEntryId || !panelEntries.some((entry) => entry.id === activePanelEntryId)) {
      setActivePanelEntryId(panelEntries[panelEntries.length - 1]!.id);
    }
  }, [activePanelEntryId, panelEntries]);

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

  const dismissPanelEntry = useCallback((entry: PanelEntry) => {
    if (entry.source === "demo" && entry.demoKind) {
      setActiveDemoWidgets((current) => current.filter((kind) => kind !== entry.demoKind));
      return;
    }
    if (!entry.messageId) {
      return;
    }
    setDismissedWidgetMessageIds((previous) => {
      if (previous.has(entry.messageId!)) {
        return previous;
      }
      const next = new Set(previous);
      next.add(entry.messageId!);
      return next;
    });
  }, []);

  const toggleDemoWidget = useCallback((kind: DevToolsDemoWidgetKind) => {
    setActiveDemoWidgets((current) =>
      current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]
    );
  }, []);

  const clearDemoWidgets = useCallback(() => {
    setActiveDemoWidgets([]);
  }, []);

  const selectPanelEntryAt = useCallback(
    (index: number) => {
      const target = panelEntries[index];
      if (!target) {
        return;
      }
      setActivePanelEntryId(target.id);
    },
    [panelEntries]
  );

  return (
    <main
      ref={appShellRef}
      className={`app-shell ${companion.isExpanded ? "is-expanded" : "is-collapsed"}`}
    >
      <SpeechBubble
        text={bubbleText}
        tone={bubbleTone}
        showThinkingIndicator={showThinkingIndicator}
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
          <DataPanelSlider activeIndex={Math.max(0, activePanelIndex)} onSelectIndex={selectPanelEntryAt}>
            {panelEntries.map((entry) => (
              <DesktopAvatarWidgetPanel
                key={entry.id}
                widget={entry.widget}
                followUpQuestions={entry.followUpQuestions}
                onSuggestionSelect={companion.submitSuggestion}
                onDismiss={() => dismissPanelEntry(entry)}
              />
            ))}
          </DataPanelSlider>
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
          activeDemoWidgets={activeDemoWidgets}
          onToggleDemoWidget={toggleDemoWidget}
          onClearDemoWidgets={clearDemoWidgets}
        />
      </div>
    </main>
  );
}

function demoFollowUpQuestions(widget: DesktopAvatarWidgetPayload): string[] {
  if (widget.type === "text") {
    return [
      "Welche Kennzahl soll ich als Nächstes zeigen?",
      "Soll ich die Periode auf 12 Monate erweitern?"
    ];
  }
  if (widget.type === "clarification") {
    return widget.suggestions;
  }
  return [];
}

function buildDemoWidget(kind: DevToolsDemoWidgetKind | null): DesktopAvatarWidgetPayload | null {
  if (!kind) {
    return null;
  }

  if (kind === "table") {
    return {
      type: "table",
      title: "Demo: Warenbewegungen",
      columns: [
        { key: "artikel", label: "Artikel" },
        { key: "lager", label: "Lager" },
        { key: "bestand", label: "Bestand" },
        { key: "trend", label: "Trend" }
      ],
      rows: [
        { artikel: "Tomatensauce 1L", lager: "Kühlhaus A", bestand: 124, trend: "stabil" },
        { artikel: "Pasta 500g", lager: "Trockenlager", bestand: 41, trend: "fallend" },
        { artikel: "Olivenöl 5L", lager: "Trockenlager", bestand: 18, trend: "kritisch" }
      ]
    };
  }

  if (kind === "keyValue") {
    return {
      type: "keyValue",
      title: "Demo: Kennzahlen",
      items: [
        { key: "orders", label: "Offene Bestellungen", value: 17 },
        { key: "late", label: "Überfällig", value: 3 },
        { key: "coverage", label: "Versorgung (Tage)", value: 6.8 }
      ]
    };
  }

  if (kind === "text") {
    return {
      type: "text",
      title: "Demo: Executive Summary",
      text: "Der Tagesverlauf ist stabil. Zwei Warengruppen sind unter Sollbestand und sollten priorisiert nachbestellt werden."
    };
  }

  if (kind === "clarification") {
    return {
      type: "clarification",
      title: "Demo: Rückfrage",
      question: "Für welchen Standort soll ich die Engpassanalyse anzeigen?",
      suggestions: ["Zentrallager", "Filiale Nord", "Alle Standorte"]
    };
  }

  if (kind === "areaChart") {
    return {
      type: "areaChart",
      title: "Demo: Nachfrageverlauf",
      xKey: "monat",
      series: [
        { key: "nachfrage", label: "Nachfrage", color: "#8de8d8" },
        { key: "angebot", label: "Angebot", color: "#80c7ff" }
      ],
      rows: [
        { monat: "Jan", nachfrage: 240, angebot: 228 },
        { monat: "Feb", nachfrage: 260, angebot: 250 },
        { monat: "Mär", nachfrage: 275, angebot: 268 },
        { monat: "Apr", nachfrage: 320, angebot: 301 },
        { monat: "Mai", nachfrage: 298, angebot: 284 },
        { monat: "Jun", nachfrage: 336, angebot: 315 }
      ],
      summary: "Trend: Nachfrage steigt schneller als Angebot. Differenz im Juni: 21 Einheiten."
    };
  }

  return {
    type: "error",
    title: "Demo: Fehlerkarte",
    message: "Die Datenquelle für diese Ansicht ist aktuell nicht verfügbar."
  };
}
