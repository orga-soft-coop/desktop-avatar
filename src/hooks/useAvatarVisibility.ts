import { useEffect, useState } from "react";
import { frontendLog, getAvatarWindowVisibility, onAvatarWindowVisibility } from "../lib/tauri";

export function avatarFrameLoop(visible: boolean, reducedMotion: boolean): "always" | "demand" | "never" {
  return !visible ? "never" : reducedMotion ? "demand" : "always";
}

export function useAvatarVisibility() {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== "hidden");
  const [nativeVisible, setNativeVisible] = useState(true);
  useEffect(() => {
    let active = true;
    let revision = 0;
    let unlisten: (() => void) | undefined;
    const updateDocument = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateDocument);
    void (async () => {
      const stop = await onAvatarWindowVisibility((visible) => {
        if (!active) return;
        revision += 1;
        setNativeVisible(visible);
      });
      if (!active) { stop(); return; }
      unlisten = stop;
      const beforeRead = revision;
      const visible = await getAvatarWindowVisibility();
      if (active && beforeRead === revision) setNativeVisible(visible);
    })().catch(() => { void frontendLog("warn", "avatar window visibility unavailable"); });
    return () => {
      active = false;
      unlisten?.();
      document.removeEventListener("visibilitychange", updateDocument);
    };
  }, []);
  return documentVisible && nativeVisible;
}
