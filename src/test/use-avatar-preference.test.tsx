import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAvatarPreference } from "../hooks/useAvatarPreference";

afterEach(() => localStorage.clear());
it.each(["unknown-avatar", "configured"])("migrates obsolete preference %s to the first bundled avatar", (old) => {
  localStorage.setItem("desktop-avatar.avatarPreference", old);
  const first = renderHook(() => useAvatarPreference());
  expect(first.result.current.selection).toBe("female_avatar_1");
  act(() => first.result.current.select("female_avatar_2"));
  expect(first.result.current.manifest?.animationLibraryUrl).toBe("/avatars/female_avatar_2/manifest.json");
  first.unmount();
  const reopened = renderHook(() => useAvatarPreference());
  expect(reopened.result.current.selection).toBe("female_avatar_2");
  act(() => reopened.result.current.select("female_avatar_1"));
  expect(reopened.result.current.manifest?.animationLibraryUrl).toBe("/avatars/female_avatar_1/manifest.json");
});
