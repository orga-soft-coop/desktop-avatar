import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AvatarStage } from "../../src/components/AvatarStage";
import type { AvatarAnimationDebug, CompanionState } from "../../src/lib/contracts";
import secondManifest from "../../public/sample-avatar-2-manifest.json";
import manifest from "../../public/sample-avatar-manifest.json";
import "../../src/styles/app.css";
import { getWindowSizesForPreset, type SizePreset } from "../../src/lib/window-presets";

const avatars = [manifest, secondManifest].map(value => ({ ...value, animationLibraryUrl: value.animationLibraryUrl.replace("./", "/") }));
const states: [CompanionState, string][] = [["idle", "Ruhe"], ["listening", "Zuhören"], ["thinking", "Denken"], ["speaking", "Sprechen"]];
function Preview() {
  const [avatarIndex, setAvatarIndex] = useState(0);
  const [state, setState] = useState<CompanionState>("idle");
  const [forced, setForced] = useState<string | null>(null);
  const [debug, setDebug] = useState<AvatarAnimationDebug>({ assetKind: null, selectedClip: null, resolvedAnimationMapping: {} });
  const [mounted, setMounted] = useState(true);
  const [names, setNames] = useState<string[]>([]);
  const [view, setView] = useState<"expanded" | SizePreset>("expanded");
  const dimensions = getWindowSizesForPreset(view === "expanded" ? "medium" : view).collapsed;
  return <main style={{ height: "100vh", background: "radial-gradient(ellipse at 50% 35%, #344c64, #142130)", color: "white", padding: "24px", overflow: "auto" }}>
    <style>{`button, select { color: #edf5ff; background: #263d53; border: 1px solid #58728c; border-radius: 8px; padding: 7px 12px; } button:focus-visible, select:focus-visible { outline: 2px solid #97d9ef; } option { background: #263d53; }`}</style>
    <header style={{ position: "relative", zIndex: 5 }}><h1 style={{ fontSize: 24 }}>{avatars[avatarIndex].displayName}</h1><p>Lokale Darstellungsvorschau · ohne Geschäfts- oder Anmeldedaten</p>
      <label>Figur <select aria-label="Figur" value={avatarIndex} onChange={event => {setAvatarIndex(Number(event.target.value)); setForced(null);}}><option value={0}>Female Avatar 1</option><option value={1}>Female Avatar 2</option></select></label>
      <label style={{marginLeft: 16}}>Animation <select aria-label="Animation" value={forced ?? ""} onChange={event => setForced(event.target.value || null)}><option value="">Automatisch</option>{names.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label style={{marginLeft: 16}}>Ansicht <select aria-label="Ansicht" value={view} onChange={event => setView(event.target.value as typeof view)}><option value="expanded">Geöffnet</option><option value="small">Geschlossen · S</option><option value="medium">Geschlossen · M</option><option value="large">Geschlossen · L</option></select></label>
      <nav style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        {states.map(([key, title]) => <button key={key} onClick={() => { setForced(null); setState(key); }}>{title}</button>)}
        <button onClick={() => setForced("teleport-out")}>Abgang</button>
        <button onClick={() => { setForced(null); setMounted(value => !value); }}>{mounted ? "Entladen" : "Laden"}</button>
      </nav><p role="status">Clip: {debug.selectedClip ?? "Lädt…"}</p>
    </header>
    <div className={view === "expanded" ? undefined : `app-shell is-peek peek-size-${view}`} style={{ position: "relative", width: view === "expanded" ? 520 : dimensions.width, height: view === "expanded" ? 560 : dimensions.height, minHeight: 0, margin: "0 auto", ...(view === "expanded" ? { "--avatar-viewport-height": "560px", "--avatar-panel-overlap": "0px" } : {}) } as React.CSSProperties}>
      {mounted && <AvatarStage companionState={state} expanded={view === "expanded"} manifest={avatars[avatarIndex]} forcedAnimation={forced} onDragStart={() => {}} onAnimationDebugChange={setDebug} onAnimationsLoaded={setNames} />}
    </div>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><Preview /></React.StrictMode>);

if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
