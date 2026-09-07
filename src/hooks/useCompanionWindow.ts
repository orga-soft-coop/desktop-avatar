import { useCallback, useEffect, useRef, useState } from "react";
import type { PeekMode, PeekPosition } from "../lib/contracts";
import { waitMs } from "../lib/companion-utils";
import { DEFAULT_SIZE_PRESET, type SizePreset, getWindowSizesForPreset, readStoredSizePreset, storeSizePreset } from "../lib/window-presets";
import { onTrayPeekCollapse, onTrayPeekOpen, onTrayPeekPositionChanged, resizeWindow, setPeekMode, setPeekPosition, startWindowDragForMode, type WindowResizeAnchor } from "../lib/tauri";

const PEEK_MODE_STORAGE_KEY = "desktop-avatar.peekMode";
const PEEK_POSITION_STORAGE_KEY = "desktop-avatar.peekPosition";
const PEEK_ANIMATION_ENABLED_STORAGE_KEY =
  "desktop-avatar.peekAnimationEnabled";
const LAST_EXPANDED_SIZE_STORAGE_KEY = "desktop-avatar.lastExpandedSize";
const DEFAULT_PEEK_MODE: PeekMode = "peek";
const DEFAULT_PEEK_POSITION: PeekPosition = "top-right";
const MODE_TRANSITION_COLLAPSE_OUT_MS = 210;
const MODE_TRANSITION_EXPAND_REVEAL_MS = 240;
const MODE_TRANSITION_PEEK_REVEAL_MS = 220;
const MODE_TRANSITION_PEEK_OUT_MS = 190;
type ModeTransitionPhase =
  | "idle"
  | "collapse-out"
  | "peek-out"
  | "peek-in"
  | "expand-prep"
  | "expand-in";

function isPeekMode(value: string | null): value is PeekMode {
  return value === "peek" || value === "expanded";
}

function isPeekPosition(value: string | null): value is PeekPosition {
  return (
    value === "top-left" ||
    value === "top-right" ||
    value === "bottom-left" ||
    value === "bottom-right"
  );
}

function readStoredPeekMode(): PeekMode {
  if (typeof window === "undefined") {
    return DEFAULT_PEEK_MODE;
  }
  try {
    // Startup must always begin in peek mode; the stored value is only
    // retained for compatibility and can still be updated at runtime.
    const raw = window.localStorage.getItem(PEEK_MODE_STORAGE_KEY);
    if (isPeekMode(raw) && raw === DEFAULT_PEEK_MODE) {
      return raw;
    }
    return DEFAULT_PEEK_MODE;
  } catch {
    return DEFAULT_PEEK_MODE;
  }
}

function storePeekMode(mode: PeekMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PEEK_MODE_STORAGE_KEY, mode);
  } catch {
    // no-op
  }
}

function readStoredPeekPosition(): PeekPosition {
  if (typeof window === "undefined") {
    return DEFAULT_PEEK_POSITION;
  }
  try {
    const raw = window.localStorage.getItem(PEEK_POSITION_STORAGE_KEY);
    return isPeekPosition(raw) ? raw : DEFAULT_PEEK_POSITION;
  } catch {
    return DEFAULT_PEEK_POSITION;
  }
}

function storePeekPosition(position: PeekPosition): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(PEEK_POSITION_STORAGE_KEY, position);
  } catch {
    // no-op
  }
}

function readStoredAnimationEnabled(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(PEEK_ANIMATION_ENABLED_STORAGE_KEY);
    return raw?.trim().toLowerCase() !== "false";
  } catch {
    return true;
  }
}

function readStoredLastExpandedHeight(fallbackHeight: number): number {
  if (typeof window === "undefined") {
    return fallbackHeight;
  }
  try {
    const raw = window.localStorage.getItem(LAST_EXPANDED_SIZE_STORAGE_KEY);
    if (!raw) {
      return fallbackHeight;
    }
    const parsed = JSON.parse(raw) as { width?: number; height?: number };
    if (typeof parsed.height === "number" && Number.isFinite(parsed.height)) {
      return Math.max(420, Math.round(parsed.height));
    }
    return fallbackHeight;
  } catch {
    return fallbackHeight;
  }
}

function storeLastExpandedSize(width: number, height: number): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      LAST_EXPANDED_SIZE_STORAGE_KEY,
      JSON.stringify({ width: Math.round(width), height: Math.round(height) }),
    );
  } catch {
    // no-op
  }
}

export function useCompanionWindow() {
  const [peekMode, setPeekModeState] = useState<PeekMode>(() =>
    readStoredPeekMode(),
  );
  const [peekPosition, setPeekPositionState] = useState<PeekPosition>(() =>
    readStoredPeekPosition(),
  );
  const [isModeTransitioning, setIsModeTransitioning] = useState(false);
  const [modeTransitionPhase, setModeTransitionPhase] =
    useState<ModeTransitionPhase>("idle");
  const [animationEnabled] = useState<boolean>(() =>
    readStoredAnimationEnabled(),
  );
  const [sizePreset, setSizePresetState] = useState<SizePreset>(() =>
    readStoredSizePreset(),
  );
  const [windowSize, setWindowSize] = useState(() => {
    const preset = getWindowSizesForPreset(DEFAULT_SIZE_PRESET);
    return {
      width: preset.expanded.width,
      height: readStoredLastExpandedHeight(preset.expanded.height),
    };
  });
  const peekModeRef = useRef<PeekMode>(peekMode);
  const applyPeekModeRef = useRef<(mode: PeekMode) => Promise<void>>(
    async () => {},
  );

  useEffect(() => {
    peekModeRef.current = peekMode;
  }, [peekMode]);

  const applyPeekPosition = useCallback(async (position: PeekPosition) => {
    setPeekPositionState(position);
    storePeekPosition(position);
    await setPeekPosition(position);
  }, []);

  const applyPeekMode = useCallback(
    async (mode: PeekMode, options?: { animate?: boolean }) => {
      const presetSizes = getWindowSizesForPreset(sizePreset);
      const expandedWidth = presetSizes.expanded.width;
      const collapsedWidth = presetSizes.collapsed.width;
      const collapsedHeight = presetSizes.collapsed.height;
      const expandedHeight =
        mode === "expanded"
          ? Math.max(presetSizes.expanded.height, windowSize.height)
          : Math.max(
              presetSizes.expanded.height,
              readStoredLastExpandedHeight(windowSize.height),
            );
      const shouldAnimate = options?.animate ?? animationEnabled;

      const clearTransition = () => {
        requestAnimationFrame(() => {
          setModeTransitionPhase("idle");
          setIsModeTransitioning(false);
        });
      };

      if (shouldAnimate && mode === "peek") {
        setModeTransitionPhase("collapse-out");
        setIsModeTransitioning(true);
        await waitMs(MODE_TRANSITION_COLLAPSE_OUT_MS);
      } else if (shouldAnimate) {
        setModeTransitionPhase("peek-out");
        setIsModeTransitioning(true);
        await waitMs(MODE_TRANSITION_PEEK_OUT_MS);
        setModeTransitionPhase("expand-prep");
      }

      try {
        await setPeekMode(
          mode,
          expandedWidth,
          expandedHeight,
          collapsedWidth,
          collapsedHeight,
          shouldAnimate,
        );
        setPeekModeState(mode);
        storePeekMode(mode);
        if (mode === "expanded") {
          const nextSize = { width: expandedWidth, height: expandedHeight };
          setWindowSize(nextSize);
          storeLastExpandedSize(nextSize.width, nextSize.height);
        }

        if (shouldAnimate) {
          if (mode === "peek") {
            setModeTransitionPhase("peek-in");
            setIsModeTransitioning(true);
            await waitMs(MODE_TRANSITION_PEEK_REVEAL_MS);
          } else {
            setModeTransitionPhase("expand-in");
            setIsModeTransitioning(true);
            await waitMs(MODE_TRANSITION_EXPAND_REVEAL_MS);
          }
        }
      } finally {
        if (shouldAnimate) {
          clearTransition();
        }
      }
    },
    [animationEnabled, sizePreset, windowSize.height],
  );

  useEffect(() => {
    applyPeekModeRef.current = (mode: PeekMode) => applyPeekMode(mode);
  }, [applyPeekMode]);

  async function setUiMode(mode: PeekMode, options?: { animate?: boolean }) {
    if (mode === peekMode) {
      return;
    }
    await applyPeekMode(mode, options);
  }

  async function toggleExpanded() {
    const nextMode: PeekMode = peekMode === "expanded" ? "peek" : "expanded";
    await setUiMode(nextMode);
  }

  async function setSizePreset(preset: SizePreset) {
    if (preset === sizePreset) {
      return;
    }

    const presetSizes = getWindowSizesForPreset(preset);
    setSizePresetState(preset);
    storeSizePreset(preset);

    const targetSize = {
      width: presetSizes.expanded.width,
      height: Math.max(windowSize.height, presetSizes.expanded.height),
    };
    if (peekMode === "expanded") {
      await resizeWindow(targetSize.width, targetSize.height);
      setWindowSize(targetSize);
      storeLastExpandedSize(targetSize.width, targetSize.height);
      await setPeekMode(
        "expanded",
        targetSize.width,
        targetSize.height,
        presetSizes.collapsed.width,
        presetSizes.collapsed.height,
        false,
      );
      return;
    }

    await setPeekMode(
      "peek",
      targetSize.width,
      targetSize.height,
      presetSizes.collapsed.width,
      presetSizes.collapsed.height,
      false,
    );
  }

  async function initializeWindow(isActive: () => boolean) {
    if (!isActive()) return;
    const presetSizes = getWindowSizesForPreset(sizePreset);
    const expandedHeight = Math.max(
      presetSizes.expanded.height,
      readStoredLastExpandedHeight(presetSizes.expanded.height),
    );
    setWindowSize({ width: presetSizes.expanded.width, height: expandedHeight });
    await setPeekMode(
      peekMode,
      presetSizes.expanded.width,
      expandedHeight,
      presetSizes.collapsed.width,
      presetSizes.collapsed.height,
      false,
      true,
    );
  }

  useEffect(() => {
    let active = true;
    let unlistenTrayPeekOpen: (() => void) | undefined;
    let unlistenTrayPeekCollapse: (() => void) | undefined;
    let unlistenTrayPeekPositionChanged: (() => void) | undefined;
    void onTrayPeekOpen(() => {
      if (!active) return;
      void applyPeekModeRef.current("expanded");
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTrayPeekOpen = unlisten;
    });

    void onTrayPeekCollapse(() => {
      if (!active) return;
      void applyPeekModeRef.current("peek");
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTrayPeekCollapse = unlisten;
    });

    void onTrayPeekPositionChanged((position) => {
      if (!active) return;
      setPeekPositionState(position);
      storePeekPosition(position);
      if (peekModeRef.current === "peek") {
        void setPeekPosition(position);
      }
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTrayPeekPositionChanged = unlisten;
    });

    return () => {
      active = false;
      unlistenTrayPeekOpen?.(); unlistenTrayPeekCollapse?.(); unlistenTrayPeekPositionChanged?.();
    };
  }, []);
  return {
    peekMode, peekPosition, isModeTransitioning, modeTransitionPhase, animationEnabled, sizePreset, windowSize,
    applyPeekMode, applyPeekPosition, setUiMode, toggleExpanded, setSizePreset, initializeWindow,
    resizeWindow: async (
      width: number,
      height: number,
      anchor?: WindowResizeAnchor,
    ) => {
      await resizeWindow(width, height, anchor);
      setWindowSize({ width, height });
      storeLastExpandedSize(width, height);
    },
    startWindowDrag: () => startWindowDragForMode(peekModeRef.current),
  };
}
