import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZE_PRESET,
  getWindowSizesForPreset,
  isSizePreset
} from "../lib/window-presets";

describe("window preset sizing", () => {
  it("defaults to medium when the preset is missing", () => {
    const preset = getWindowSizesForPreset(DEFAULT_SIZE_PRESET);
    expect(preset.collapsed.width).toBe(520);
    expect(preset.expanded.height).toBe(620);
  });

  it("accepts only known preset ids", () => {
    expect(isSizePreset("small")).toBe(true);
    expect(isSizePreset("medium")).toBe(true);
    expect(isSizePreset("large")).toBe(true);
    expect(isSizePreset("xl")).toBe(false);
  });
});
