import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { MIN_CONTENT_WINDOW_HEIGHT } from "../lib/window-layout";
import { getWindowSizesForPreset, type SizePreset } from "../lib/window-presets";
import { getWindowGeometry, type WindowResizeAnchor } from "../lib/tauri";

const WIDGET_DOCK_WIDTH = 620;
const WIDGET_DOCK_EDGE_THRESHOLD = 18;
const WIDGET_DOCK_SWITCH_HYSTERESIS = 56;

type WidgetDockSide = "left" | "right";
interface WidgetDockLayoutOptions {
  isExpanded: boolean;
  sizePreset: SizePreset;
  windowSize: { width: number; height: number };
  widgetDockVisible: boolean;
  resizeWindow: (width: number, height: number, anchor?: WindowResizeAnchor) => Promise<void>;
}

export function useWidgetDockLayout({ isExpanded, sizePreset, windowSize, widgetDockVisible, resizeWindow }: WidgetDockLayoutOptions) {
  const [widgetDockSide, setWidgetDockSide] = useState<WidgetDockSide>("right");
  const appShellRef = useRef<HTMLElement>(null);
  const previousExpandedRef = useRef(isExpanded);
  const reopenLeftDockAnchorGuardRef = useRef(false);

  const lastResizedHeight = useRef(0);
  const lastResizedWidth = useRef(0);
  const resizeWindowRef = useRef(resizeWindow);
  resizeWindowRef.current = resizeWindow;

  useEffect(() => {
    if (isExpanded && !previousExpandedRef.current) {
      reopenLeftDockAnchorGuardRef.current = true;
    }
    if (!isExpanded || widgetDockSide === "right") {
      reopenLeftDockAnchorGuardRef.current = false;
    }
    previousExpandedRef.current = isExpanded;
  }, [isExpanded, widgetDockSide]);

  const presetSizes = getWindowSizesForPreset(sizePreset);
  const expandedContentWidth = presetSizes.expanded.width;
  const expectedWindowWidth = Math.round(
    expandedContentWidth + (widgetDockVisible ? WIDGET_DOCK_WIDTH : 0)
  );
  const widgetDockReady =
    !widgetDockVisible || Math.abs(windowSize.width - expectedWindowWidth) < 2;
  const expandedContentStyle: CSSProperties | undefined = isExpanded
    ? { width: `${expandedContentWidth}px` }
    : undefined;
  const updateWidgetDockSide = useCallback(async () => {
    if (!isExpanded) {
      return;
    }
    const geometry = await getWindowGeometry().catch(() => null);
    if (!geometry) {
      return;
    }
    const leftSpace = geometry.x;
    const rightSpace = geometry.screenWidth - (geometry.x + geometry.width);
    const requiredSpace = WIDGET_DOCK_WIDTH + WIDGET_DOCK_EDGE_THRESHOLD;
    const canFitLeft = leftSpace >= requiredSpace;
    const canFitRight = rightSpace >= requiredSpace;

    setWidgetDockSide((current) => {
      // Deterministic fit rule: choose the side that can fully fit the dock.
      if (canFitLeft && !canFitRight) {
        return "left";
      }
      if (canFitRight && !canFitLeft) {
        return "right";
      }
      if (!canFitLeft && !canFitRight) {
        // Neither side fits completely: keep the side with more remaining room.
        return leftSpace >= rightSpace ? "left" : "right";
      }

      // Both sides fit: keep hysteresis to avoid jitter while dragging.
      if (
        current === "right" &&
        leftSpace > rightSpace + WIDGET_DOCK_SWITCH_HYSTERESIS
      ) {
        return "left";
      }
      if (
        current === "left" &&
        rightSpace > leftSpace + WIDGET_DOCK_SWITCH_HYSTERESIS
      ) {
        return "right";
      }
      return current;
    });
  }, [isExpanded]);

  // Fit the native window to the measured layout.
  const syncWindowHeight = useCallback(() => {
    if (!isExpanded) {
      return;
    }
    const shell = appShellRef.current;
    if (!shell) return;

    const preset = getWindowSizesForPreset(sizePreset);
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
    let resizeAnchor: "left" | "right" = "left";
    if (widgetDockSide === "left") {
      // After reopening from peek, keep the left origin once so we restore
      // the previous expanded rect before returning to right-anchor behavior.
      if (reopenLeftDockAnchorGuardRef.current) {
        resizeAnchor = "left";
        reopenLeftDockAnchorGuardRef.current = false;
      } else {
        resizeAnchor = "right";
      }
    }
    void resizeWindowRef.current(targetWidth, targetHeight, resizeAnchor);
  }, [sizePreset, isExpanded, widgetDockSide, widgetDockVisible]);

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
    // The native shell can change size externally when switching peek/expanded mode.
    // Reset cached dimensions so the next sync always re-applies the correct dock width.
    lastResizedHeight.current = 0;
    lastResizedWidth.current = 0;
    if (!isExpanded) {
      return;
    }
    const id = requestAnimationFrame(() => syncWindowHeight());
    return () => cancelAnimationFrame(id);
  }, [isExpanded, widgetDockVisible, syncWindowHeight]);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }
    void updateWidgetDockSide();
    const intervalId = window.setInterval(() => {
      void updateWidgetDockSide();
    }, 120);
    return () => window.clearInterval(intervalId);
  }, [isExpanded, updateWidgetDockSide]);

  const adjustWindowHeight = useCallback(
    (delta: number) => {
      const nextHeight = Math.max(MIN_CONTENT_WINDOW_HEIGHT, windowSize.height + delta);
      const widgetWidth = widgetDockVisible ? WIDGET_DOCK_WIDTH : 0;
      const targetWidth = Math.round(
        getWindowSizesForPreset(sizePreset).expanded.width + widgetWidth
      );
      lastResizedWidth.current = targetWidth;
      lastResizedHeight.current = nextHeight;
      const resizeAnchor = widgetDockSide === "left" ? "right" : "left";
      void resizeWindow(targetWidth, nextHeight, resizeAnchor);
    },
    [resizeWindow, sizePreset, windowSize.height, widgetDockSide, widgetDockVisible]
  );

  return { appShellRef, widgetDockSide, widgetDockReady, expandedContentStyle, updateWidgetDockSide, adjustWindowHeight };
}
