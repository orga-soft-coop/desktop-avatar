export type SizePreset = "small" | "medium" | "large";

export interface WindowDimensions {
  width: number;
  height: number;
}

interface WindowPresetConfig {
  id: SizePreset;
  label: string;
  collapsed: WindowDimensions;
  expanded: WindowDimensions;
}

export const DEFAULT_SIZE_PRESET: SizePreset = "medium";
export const SIZE_PRESET_STORAGE_KEY = "desktop-avatar:size-preset";

export const SIZE_PRESET_OPTIONS: WindowPresetConfig[] = [
  {
    id: "small",
    label: "S",
    collapsed: { width: 440, height: 500 },
    expanded: { width: 440, height: 580 }
  },
  {
    id: "medium",
    label: "M",
    collapsed: { width: 520, height: 520 },
    expanded: { width: 520, height: 620 }
  },
  {
    id: "large",
    label: "L",
    collapsed: { width: 600, height: 540 },
    expanded: { width: 600, height: 660 }
  }
];

export function isSizePreset(value: string | null | undefined): value is SizePreset {
  return SIZE_PRESET_OPTIONS.some((preset) => preset.id === value);
}

export function getWindowSizesForPreset(preset: SizePreset): WindowPresetConfig {
  return (
    SIZE_PRESET_OPTIONS.find((candidate) => candidate.id === preset) ??
    SIZE_PRESET_OPTIONS.find((candidate) => candidate.id === DEFAULT_SIZE_PRESET)!
  );
}

export function readStoredSizePreset(): SizePreset {
  if (typeof window === "undefined") {
    return DEFAULT_SIZE_PRESET;
  }

  const value = window.localStorage.getItem(SIZE_PRESET_STORAGE_KEY);
  return isSizePreset(value) ? value : DEFAULT_SIZE_PRESET;
}

export function storeSizePreset(preset: SizePreset): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(SIZE_PRESET_STORAGE_KEY, preset);
}
