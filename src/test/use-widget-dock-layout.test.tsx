import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWidgetDockLayout } from "../hooks/useWidgetDockLayout";

const geometry = vi.hoisted(() => vi.fn());
vi.mock("../lib/tauri", () => ({ getWindowGeometry: geometry }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("fits the left dock, keeps its right edge, and restores the origin once after reopening", async () => {
  geometry.mockResolvedValue({ x: 1500, y: 40, width: 520, height: 620, screenWidth: 2200, screenHeight: 1200 });
  const resizeWindow = vi.fn(async () => {});
  const options = { isExpanded: true, sizePreset: "medium" as const, windowSize: { width: 520, height: 620 }, widgetDockVisible: false, resizeWindow };
  const view = renderHook(props => useWidgetDockLayout(props), { initialProps: options });
  const shell = document.createElement("section");
  Object.defineProperty(shell, "scrollHeight", { value: 680 });
  act(() => { view.result.current.appShellRef.current = shell; });
  await waitFor(() => expect(view.result.current.widgetDockSide).toBe("left"));
  view.rerender({ ...options, widgetDockVisible: true });
  await waitFor(() => expect(resizeWindow).toHaveBeenLastCalledWith(1140, 680, "right"));
  expect(view.result.current.widgetDockReady).toBe(false);
  view.rerender({ ...options, widgetDockVisible: true, windowSize: { width: 1140, height: 680 } });
  expect(view.result.current.widgetDockReady).toBe(true);
  view.rerender({ ...options, isExpanded: false, widgetDockVisible: true });
  resizeWindow.mockClear();
  view.rerender({ ...options, isExpanded: true, widgetDockVisible: true });
  await waitFor(() => expect(resizeWindow).toHaveBeenCalled());
  expect(resizeWindow.mock.calls[0]).toEqual([1140, 680, "left"]);
});

it("uses the right dock when only the right side fits and applies the preset width", async () => {
  geometry.mockResolvedValue({ x: 80, y: 40, width: 440, height: 620, screenWidth: 2200, screenHeight: 1200 });
  const resizeWindow = vi.fn(async () => {});
  const view = renderHook(() => useWidgetDockLayout({ isExpanded: true, sizePreset: "small", windowSize: { width: 440, height: 620 }, widgetDockVisible: true, resizeWindow }));
  await act(async () => { await view.result.current.updateWidgetDockSide(); });
  expect(view.result.current.widgetDockSide).toBe("right");
  act(() => view.result.current.adjustWindowHeight(40));
  expect(resizeWindow).toHaveBeenCalledWith(1060, 660, "left");
});
