import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
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
import { getWindowGeometry } from "./lib/tauri";

const TEXT_WIDGET_BUBBLE_ONLY_MAX_CHARS = 220;
const PEEK_REST_ANIMATION_STORAGE_KEY = "desktop-avatar.peekRestAnimationClip";
const STARTUP_TELEPORT_OUT_FALLBACK_MS = 2600;
const WIDGET_DOCK_WIDTH = 620;
const WIDGET_PANEL_FADE_MS = 140;
const WIDGET_DOCK_EDGE_THRESHOLD = 18;
const WIDGET_DOCK_SWITCH_HYSTERESIS = 56;
const PEEK_SHADOW_PADDING = 20;
const PEEK_CAMERA_REFERENCE_SCALE = 2.28;
const PEEK_CAMERA_TARGET_Y_OFFSET = 0.12;

type WidgetDockSide = "left" | "right";

function resolvePeekVisualDiameter(width: number, height: number): number {
  const diameter = Math.min(width, height);
  return Math.max(1, diameter - PEEK_SHADOW_PADDING * 2);
}

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
  const isExpanded = companion.peekMode === "expanded";
  const isPeek = companion.peekMode === "peek";
  const [peekRestAnimationClip] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const value = window.localStorage.getItem(PEEK_REST_ANIMATION_STORAGE_KEY)?.trim() ?? "";
    return value.length > 0 ? value : null;
  });
  const [dismissedWidgetMessageIds, setDismissedWidgetMessageIds] = useState<Set<string>>(
    () => new Set()
  );
  const [activeDemoWidgets, setActiveDemoWidgets] = useState<DevToolsDemoWidgetKind[]>([]);
  const [activePanelEntryId, setActivePanelEntryId] = useState<string | null>(null);
  const [renderedPanelEntries, setRenderedPanelEntries] = useState<PanelEntry[]>([]);
  const [widgetPanelState, setWidgetPanelState] = useState<
    "closed" | "opening" | "open" | "closing"
  >("closed");
  const [widgetDockSide, setWidgetDockSide] = useState<WidgetDockSide>("right");
  const [animationNames, setAnimationNames] = useState<string[]>([]);
  const [cameraConfig, setCameraConfig] = useState<AvatarCameraConfig>(
    DEFAULT_AVATAR_CAMERA_CONFIG
  );
  const [forcedAnimation, setForcedAnimation] = useState<string | null>(null);
  const [startupOneShotAnimation, setStartupOneShotAnimation] = useState<string | null>(null);
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
  const peekPressStateRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressNextPeekOpenRef = useRef(false);
  const startupTeleportOutTriggeredRef = useRef(false);

  const handleAnimationsLoaded = useCallback((names: string[]) => {
    setAnimationNames(names);
  }, []);

  const lastResizedHeight = useRef(0);
  const lastResizedWidth = useRef(0);
  const resizeWindowRef = useRef(companion.resizeWindow);
  resizeWindowRef.current = companion.resizeWindow;

  const latestAssistantMessage = [...companion.messages]
    .reverse()
    .find((message) => message.role === "assistant" && (message.text.trim() || message.widget));
  const defaultBubbleText = isExpanded ? t("app.defaultBubble") : "";
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
  const widgetTooltipOpen = isExpanded && Boolean(visiblePanelWidget);
  const widgetDockVisible = isExpanded && (widgetTooltipOpen || renderedPanelEntries.length > 0);
  const displayedPanelEntries = widgetTooltipOpen ? panelEntries : renderedPanelEntries;
  const displayedActivePanelIndex = displayedPanelEntries.findIndex(
    (entry) => entry.id === activePanelEntryId
  );
  const clampedDisplayedActivePanelIndex =
    displayedPanelEntries.length === 0
      ? -1
      : displayedActivePanelIndex >= 0
        ? displayedActivePanelIndex
        : displayedPanelEntries.length - 1;
  const displayedActiveWidget =
    clampedDisplayedActivePanelIndex >= 0
      ? displayedPanelEntries[clampedDisplayedActivePanelIndex]?.widget ?? null
      : null;
  const hasWidgetSliderNav = displayedPanelEntries.length > 1;
  const widgetArrowTone = displayedActiveWidget?.type === "error" ? "error" : "default";
  const cameraConfigSnippet = formatAvatarCameraConfig(cameraConfig);
  const presetSizes = getWindowSizesForPreset(companion.sizePreset);
  const expandedContentWidth = presetSizes.expanded.width;
  const expandedContentStyle: CSSProperties | undefined = isExpanded
    ? { width: `${expandedContentWidth}px` }
    : undefined;
  const peekVisualDiameter = resolvePeekVisualDiameter(
    presetSizes.collapsed.width,
    presetSizes.collapsed.height
  );
  const avatarStageCameraConfig: AvatarCameraConfig = isPeek
    ? {
        ...cameraConfig,
        target: {
          ...cameraConfig.target,
          y: cameraConfig.target.y + PEEK_CAMERA_TARGET_Y_OFFSET
        },
        referenceHeight: peekVisualDiameter * PEEK_CAMERA_REFERENCE_SCALE
      }
    : cameraConfig;
  const effectiveForcedAnimation = startupOneShotAnimation
    ? startupOneShotAnimation
    : isPeek
      ? (peekRestAnimationClip ?? forcedAnimation)
      : forcedAnimation;

  const updateWidgetDockSide = useCallback(async () => {
    if (!isExpanded || !widgetDockVisible) {
      return;
    }
    const geometry = await getWindowGeometry().catch(() => null);
    if (!geometry) {
      return;
    }
    const leftSpace = geometry.x;
    const rightSpace = geometry.screenWidth - (geometry.x + geometry.width);
    setWidgetDockSide((current) => {
      if (
        current === "right" &&
        rightSpace < WIDGET_DOCK_EDGE_THRESHOLD &&
        leftSpace > rightSpace + WIDGET_DOCK_SWITCH_HYSTERESIS
      ) {
        return "left";
      }
      if (
        current === "left" &&
        leftSpace < WIDGET_DOCK_EDGE_THRESHOLD &&
        rightSpace > leftSpace + WIDGET_DOCK_SWITCH_HYSTERESIS
      ) {
        return "right";
      }
      return current;
    });
  }, [isExpanded, widgetDockVisible]);

  // Fit the native window to the measured layout.
  const syncWindowHeight = useCallback(() => {
    if (!isExpanded) {
      return;
    }
    const shell = appShellRef.current;
    if (!shell) return;

    const preset = getWindowSizesForPreset(companion.sizePreset);
    const widgetWidth = widgetDockVisible ? WIDGET_DOCK_WIDTH : 0;
    const targetWidth = Math.round(preset.expanded.width + widgetWidth);
    const measured = Math.ceil(
      Math.max(shell.scrollHeight, shell.getBoundingClientRect().height)
    );
    const targetHeight = Math.max(MIN_CONTENT_WINDOW_HEIGHT, measured);

    const sameHeight = Math.abs(targetHeight - lastResizedHeight.current) < 2;
    const sameWidth = Math.abs(targetWidth - lastResizedWidth.current) < 2;
    if (sameHeight && sameWidth) return;
    lastResizedHeight.current = targetHeight;
    lastResizedWidth.current = targetWidth;
    void resizeWindowRef.current(targetWidth, targetHeight);
  }, [companion.sizePreset, isExpanded, widgetDockVisible]);

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

  useEffect(() => {
    if (panelEntries.length > 0) {
      setRenderedPanelEntries(panelEntries);
    }
  }, [panelEntries]);

  useEffect(() => {
    if (widgetTooltipOpen) {
      setWidgetPanelState((current) => (current === "open" ? "open" : "opening"));
      let rafOne = 0;
      let rafTwo = 0;
      rafOne = requestAnimationFrame(() => {
        rafTwo = requestAnimationFrame(() => {
          setWidgetPanelState("open");
        });
      });
      return () => {
        cancelAnimationFrame(rafOne);
        cancelAnimationFrame(rafTwo);
      };
    }

    if (renderedPanelEntries.length === 0) {
      setWidgetPanelState("closed");
      return;
    }

    setWidgetPanelState((current) => (current === "closed" ? "closed" : "closing"));
    const timeoutId = window.setTimeout(() => {
      setWidgetPanelState("closed");
      setRenderedPanelEntries([]);
    }, WIDGET_PANEL_FADE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [renderedPanelEntries.length, widgetTooltipOpen]);

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
  }, [widgetDockVisible, syncWindowHeight]);

  useEffect(() => {
    if (startupTeleportOutTriggeredRef.current) {
      return;
    }
    if (companion.peekMode !== "peek") {
      return;
    }
    if (companion.isModeTransitioning || companion.modeTransitionPhase !== "idle") {
      return;
    }

    startupTeleportOutTriggeredRef.current = true;
    setStartupOneShotAnimation("teleport-out");
  }, [companion.isModeTransitioning, companion.modeTransitionPhase, companion.peekMode]);

  useEffect(() => {
    if (!startupOneShotAnimation) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setStartupOneShotAnimation((current) =>
        current === startupOneShotAnimation ? null : current
      );
    }, STARTUP_TELEPORT_OUT_FALLBACK_MS);
    return () => window.clearTimeout(timeoutId);
  }, [startupOneShotAnimation]);

  const handleForcedAnimationFinished = useCallback((finishedName: string) => {
    const normalized = finishedName.trim().toLowerCase();
    if (normalized === "teleport-out" || normalized === "teleported-out") {
      setStartupOneShotAnimation(null);
    }
  }, []);

  useEffect(() => {
    if (!isExpanded || !widgetDockVisible) {
      return;
    }
    void updateWidgetDockSide();
    const intervalId = window.setInterval(() => {
      void updateWidgetDockSide();
    }, 120);
    return () => window.clearInterval(intervalId);
  }, [isExpanded, updateWidgetDockSide, widgetDockVisible]);

  const adjustWindowHeight = useCallback(
    (delta: number) => {
      const nextHeight = Math.max(MIN_CONTENT_WINDOW_HEIGHT, companion.windowSize.height + delta);
      const widgetWidth = widgetDockVisible ? WIDGET_DOCK_WIDTH : 0;
      const targetWidth = Math.round(
        getWindowSizesForPreset(companion.sizePreset).expanded.width + widgetWidth
      );
      lastResizedWidth.current = targetWidth;
      lastResizedHeight.current = nextHeight;
      void companion.resizeWindow(targetWidth, nextHeight);
    },
    [companion, widgetDockVisible]
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

  const closeAllWidgets = useCallback(() => {
    setActiveDemoWidgets([]);
    setDismissedWidgetMessageIds((previous) => {
      const next = new Set(previous);
      for (const entry of panelEntries) {
        if (entry.source === "request" && entry.messageId) {
          next.add(entry.messageId);
        }
      }
      return next;
    });
  }, [panelEntries]);

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
      className={`app-shell ${isExpanded ? "is-expanded" : "is-peek"} peek-size-${companion.sizePreset} ${companion.isModeTransitioning ? "is-mode-transitioning" : ""} ${companion.modeTransitionPhase !== "idle" ? `mode-transition-${companion.modeTransitionPhase}` : ""} ${widgetTooltipOpen ? "has-widget-tooltip" : ""} ${widgetDockVisible ? "widget-dock-visible" : ""} widget-dock-${widgetDockSide}`}
    >
      <div className={`app-content-column ${isExpanded ? "is-expanded" : ""}`} style={expandedContentStyle}>
        {isExpanded ? (
          <SpeechBubble
            text={bubbleText}
            tone={bubbleTone}
            showThinkingIndicator={showThinkingIndicator}
            onDragStart={companion.startWindowDrag}
          />
        ) : null}

        <AvatarStage
          companionState={companion.companionState}
          expanded={isExpanded}
          manifest={companion.avatarManifest}
          cameraConfig={avatarStageCameraConfig}
          forcedAnimation={effectiveForcedAnimation}
          suggestedAnimation={isPeek ? "idle" : companion.activeAnimation}
          onDragStart={companion.startWindowDrag}
          onAnimationsLoaded={handleAnimationsLoaded}
          onAnimationDebugChange={setAvatarDebug}
          onForcedAnimationFinished={handleForcedAnimationFinished}
        />

        {isPeek ? (
          <button
            className="peek-hit-target"
            type="button"
            onMouseDown={(event) => {
              if (event.button !== 0) {
                return;
              }
              peekPressStateRef.current = {
                x: event.clientX,
                y: event.clientY,
                dragging: false
              };
            }}
            onMouseMove={(event) => {
              const current = peekPressStateRef.current;
              if (!current || current.dragging) {
                return;
              }
              const delta = Math.hypot(event.clientX - current.x, event.clientY - current.y);
              if (delta < 6) {
                return;
              }
              current.dragging = true;
              suppressNextPeekOpenRef.current = true;
              void companion.startWindowDrag();
            }}
            onMouseUp={() => {
              peekPressStateRef.current = null;
            }}
            onMouseLeave={() => {
              if (!peekPressStateRef.current?.dragging) {
                return;
              }
              peekPressStateRef.current = null;
            }}
            onClick={() => {
              if (suppressNextPeekOpenRef.current) {
                suppressNextPeekOpenRef.current = false;
                return;
              }
              void companion.openAgent();
            }}
            aria-label={t("chat.openAgent")}
          />
        ) : null}

        {isExpanded ? (
          <div className="bottom-stack">
            <ChatPanel
              draft={companion.draft}
              error={companion.error}
              isExpanded={isExpanded}
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
        ) : null}
      </div>

      {widgetPanelState !== "closed" ? (
        <div
          className="widget-tooltip-panel"
          data-state={widgetPanelState}
          data-has-nav={hasWidgetSliderNav ? "true" : "false"}
          data-widget-tone={widgetArrowTone}
        >
          <div className="widget-tooltip-panel__arrow" aria-hidden="true" />
          <DataPanelSlider
            activeIndex={Math.max(0, clampedDisplayedActivePanelIndex)}
            onSelectIndex={selectPanelEntryAt}
            onCloseAll={closeAllWidgets}
          >
            {displayedPanelEntries.map((entry) => (
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
        { artikel: "Olivenöl 5L", lager: "Trockenlager", bestand: 18, trend: "kritisch" },
        { artikel: "Parmesan 2kg", lager: "Kühlhaus A", bestand: 33, trend: "stabil" },
        { artikel: "Basmati Reis 10kg", lager: "Trockenlager", bestand: 57, trend: "steigend" },
        { artikel: "H-Milch 1L", lager: "Kühlhaus B", bestand: 22, trend: "fallend" },
        { artikel: "Mineralwasser 0.75L", lager: "Getränkelager", bestand: 210, trend: "stabil" },
        { artikel: "Lachsfilet 2kg", lager: "Tiefkühlhaus", bestand: 12, trend: "kritisch" },
        { artikel: "Hähnchenbrust 5kg", lager: "Tiefkühlhaus", bestand: 29, trend: "fallend" },
        { artikel: "Eier M (30er)", lager: "Kühlhaus B", bestand: 65, trend: "stabil" },
        { artikel: "Butter 250g", lager: "Kühlhaus B", bestand: 48, trend: "stabil" },
        { artikel: "Joghurt Natur 1kg", lager: "Kühlhaus A", bestand: 27, trend: "fallend" },
        { artikel: "Tomaten frisch 5kg", lager: "Frischelager", bestand: 14, trend: "kritisch" },
        { artikel: "Gurke frisch 5kg", lager: "Frischelager", bestand: 19, trend: "fallend" },
        { artikel: "Zwiebeln 10kg", lager: "Trockenlager", bestand: 73, trend: "stabil" },
        { artikel: "Kartoffeln 25kg", lager: "Trockenlager", bestand: 44, trend: "stabil" },
        { artikel: "Rinderfond 1L", lager: "Trockenlager", bestand: 16, trend: "fallend" },
        { artikel: "Gemüsebrühe 1kg", lager: "Trockenlager", bestand: 37, trend: "stabil" },
        { artikel: "Pfeffer schwarz 1kg", lager: "Gewürzlager", bestand: 9, trend: "kritisch" },
        { artikel: "Salz fein 5kg", lager: "Gewürzlager", bestand: 58, trend: "stabil" },
        { artikel: "Zucker 10kg", lager: "Trockenlager", bestand: 52, trend: "stabil" },
        { artikel: "Kaffeebohnen 1kg", lager: "Getränkelager", bestand: 31, trend: "fallend" },
        { artikel: "Espresso Bohnen 1kg", lager: "Getränkelager", bestand: 24, trend: "stabil" },
        { artikel: "Haferdrink 1L", lager: "Kühlhaus B", bestand: 38, trend: "steigend" }
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
        { key: "nachfrage", label: "Nachfrage", color: "#7FB6DA" },
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
