import { useState } from "react";
import { BUNDLED_AVATARS, isAvatarPreference, type AvatarPreference } from "../lib/bundled-avatars";

const STORAGE_KEY = "desktop-avatar.avatarPreference";

// Called only inside the authenticated app. The selection is a device UI preference.
export function useAvatarPreference() {
  const [selection, setSelection] = useState<AvatarPreference>(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return isAvatarPreference(stored) ? stored : "female_avatar_1";
    } catch {
      console.warn("Avatar preference storage unavailable; using Female Avatar 1.");
      return "female_avatar_1";
    }
  });
  const select = (next: AvatarPreference) => {
    if (!isAvatarPreference(next)) return;
    setSelection(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      console.warn("Avatar preference storage unavailable; selection applies to this session.");
    }
  };
  return {
    selection, select,
    manifest: BUNDLED_AVATARS.find((avatar) => avatar.id === selection)?.manifest ?? BUNDLED_AVATARS[0].manifest
  };
}
