import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { avatarFrameLoop, useAvatarVisibility } from "../hooks/useAvatarVisibility";
const mocks = vi.hoisted(() => ({ read: vi.fn(), listen: vi.fn(), log: vi.fn() }));
vi.mock("../lib/tauri", () => ({ getAvatarWindowVisibility: mocks.read, onAvatarWindowVisibility: mocks.listen, frontendLog: mocks.log }));
beforeEach(() => {
  mocks.read.mockReset().mockResolvedValue(true);
  mocks.listen.mockReset().mockResolvedValue(() => {});
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => vi.restoreAllMocks());

it("renders animated visible figures continuously, static figures on demand and hidden figures never", () => {
  expect(avatarFrameLoop(true, false)).toBe("always");
  expect(avatarFrameLoop(true, true)).toBe("demand");
  expect(avatarFrameLoop(false, false)).toBe("never");
  expect(avatarFrameLoop(false, true)).toBe("never");
});
it("combines native hiding and document visibility without reacting to focus loss", async () => {
  const unlisten = vi.fn();
  let native!: (value: boolean) => void;
  mocks.listen.mockImplementation(async (callback) => { native = callback; return unlisten; });
  const { result, unmount } = renderHook(() => useAvatarVisibility());
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => window.dispatchEvent(new Event("blur")));
  expect(result.current).toBe(true);
  act(() => native(false));
  expect(result.current).toBe(false);
  act(() => { Object.defineProperty(document, "visibilityState", { value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); native(true); });
  expect(result.current).toBe(false);
  act(() => { Object.defineProperty(document, "visibilityState", { value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  expect(result.current).toBe(true);
  unmount(); expect(unlisten).toHaveBeenCalledOnce();
});
it("ignores an initial snapshot arriving after a hide event and releases late subscriptions", async () => {
  let resolveRead!: (value: boolean) => void;
  let native!: (value: boolean) => void;
  mocks.read.mockReturnValue(new Promise<boolean>((resolve) => { resolveRead = resolve; }));
  mocks.listen.mockImplementation(async (callback) => { native = callback; return () => {}; });
  const first = renderHook(() => useAvatarVisibility());
  await waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
  act(() => native(false));
  await act(async () => resolveRead(true));
  expect(first.result.current).toBe(false);
  first.unmount();
  let resolveListen!: (value: () => void) => void;
  mocks.listen.mockReturnValue(new Promise<() => void>((resolve) => { resolveListen = resolve; }));
  const second = renderHook(() => useAvatarVisibility());
  second.unmount();
  const dispose = vi.fn(); await act(async () => resolveListen(dispose));
  expect(dispose).toHaveBeenCalledOnce();
});
