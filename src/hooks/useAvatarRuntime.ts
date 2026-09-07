import { useEffect, useState } from "react";
import type { AvatarManifest } from "../lib/contracts";
import { loadAvatarRuntime, type AvatarRuntime } from "../lib/avatar-runtime";
import { t } from "../lib/i18n";

interface LoadedState {
  manifest: AvatarManifest | null;
  runtime: AvatarRuntime | null;
  error: string | null;
}

export function useAvatarRuntime(manifest: AvatarManifest | null) {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  useEffect(() => {
    let cancelled = false;
    let ownedRuntime: AvatarRuntime | undefined;
    if (!manifest) return;
    void loadAvatarRuntime(manifest).then((runtime) => {
      if (cancelled) {
        runtime.dispose();
        return;
      }
      ownedRuntime = runtime;
      setLoaded({ manifest, runtime, error: null });
    }).catch((error: unknown) => {
      if (cancelled) return;
      setLoaded({ manifest, runtime: null, error: error instanceof Error ? error.message : t("errors.avatarLoadFailed") });
    });
    return () => {
      cancelled = true;
      ownedRuntime?.dispose();
    };
  }, [manifest]);

  if (!manifest) return { runtime: null, error: t("errors.avatarManifestMissing") };
  return loaded?.manifest === manifest ? loaded : { runtime: null, error: null };
}
