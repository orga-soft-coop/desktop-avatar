import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AvatarManifest } from "../lib/contracts";
import type { AvatarRuntime } from "../lib/avatar-runtime";
import { useAvatarRuntime } from "../hooks/useAvatarRuntime";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../lib/avatar-runtime", () => ({ loadAvatarRuntime: mocks.load }));
const manifest = (name: string): AvatarManifest => ({ displayName: name, animationLibraryUrl: name });
function deferred() {
  let resolve!: (runtime: AvatarRuntime) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AvatarRuntime>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const runtime = () => ({ dispose: vi.fn() }) as unknown as AvatarRuntime;

describe("avatar load lifecycle", () => {
  it("discards older loads arriving after a replacement and disposes each owner once", async () => {
    const old = deferred(); const next = deferred();
    mocks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender, unmount } = renderHook(({ value }) => useAvatarRuntime(value), { initialProps: { value: manifest("old") } });
    rerender({ value: manifest("new") });
    const newRuntime = runtime(); const oldRuntime = runtime();
    await act(async () => next.resolve(newRuntime));
    await waitFor(() => expect(result.current.runtime).toBe(newRuntime));
    await act(async () => old.resolve(oldRuntime));
    expect(oldRuntime.dispose).toHaveBeenCalledTimes(1);
    expect(result.current.runtime).toBe(newRuntime);
    unmount();
    expect(newRuntime.dispose).toHaveBeenCalledTimes(1);
  });
  it("disposes a load completed after unmount", async () => {
    const load = deferred(); mocks.load.mockReturnValueOnce(load.promise);
    const { unmount } = renderHook(() => useAvatarRuntime(manifest("old")));
    unmount(); const value = runtime();
    await act(async () => load.resolve(value));
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not expose a stale failure and removes a mounted model for a null manifest", async () => {
    const old = deferred(); const next = deferred();
    mocks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ value }: { value: AvatarManifest | null }) => useAvatarRuntime(value), { initialProps: { value: manifest("old") as AvatarManifest | null } });
    rerender({ value: manifest("new") });
    await act(async () => old.reject(new Error("stale")));
    expect(result.current.error).toBeNull();
    const value = runtime(); await act(async () => next.resolve(value));
    rerender({ value: null });
    expect(result.current.runtime).toBeNull();
    expect(value.dispose).toHaveBeenCalledTimes(1);
  });
});
