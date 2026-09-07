import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AvatarStage } from "../../src/components/AvatarStage";
import { ChatPanel } from "../../src/components/ChatPanel";
import { useAvatarPreference } from "../../src/hooks/useAvatarPreference";
import { setLocale, type LocaleId } from "../../src/lib/i18n";
import type { ChatMessage, CompanionState } from "../../src/lib/contracts";
import type { SizePreset } from "../../src/lib/window-presets";
import "../../src/styles/app.css";

const message = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({ id, role, text, source: "text", createdAt: "2026-09-06" });
const history = Array.from({ length: 12 }, (_, index) => message(String(index), index % 2 ? "assistant" : "user", `Testnachricht ${index + 1}: Dies ist ein lokaler Beispieltext für die Prüfung des Chatverlaufs. Es werden keine Anfragen an Agent Studio gesendet.`));
function Preview() {
  const avatar = useAvatarPreference();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(history);
  const [streaming, setStreaming] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [locale, chooseLocale] = useState<LocaleId>("de");
  const [voice, setVoice] = useState<string | null>(null);
  const [size, setSize] = useState<SizePreset>("medium");
  const [state, setState] = useState<CompanionState>("idle");
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setMessages(current => current.map(item => item.id === "stream" ? { ...item, text: item.text + " Weiterer Testtext." } : item)), 500);
    return () => clearInterval(timer);
  }, [streaming]);
  const start = () => {
    setMessages([...history, message("prompt", "user", draft || "Lokale Testantwort"), { ...message("stream", "assistant", "Antwort beginnt."), isStreaming: true }]);
    setDraft(""); setStreaming(true);
  };
  const stop = () => { setStreaming(false); setMessages(current => current.map(item => item.id === "stream" ? { ...item, isStreaming: false, outputStopped: true } : item)); };
  return <main data-theme={theme} className="app-shell companion-review" style={{ height: "100vh", width: "100vw", position: "relative", pointerEvents: "auto", overflow: "auto", background: theme === "dark" ? "#152535" : "#dfe9f0", padding: 24 }}>
    <style>{`.companion-review { background: ${theme === "dark" ? "#152535" : "#dfe9f0"} !important; } .companion-review > header { color: ${theme === "dark" ? "#edf5ff" : "#152535"}; } .companion-review .chat-panel { position: relative; width: 100%; pointer-events: auto; } .review-grid { display:grid; grid-template-columns:minmax(300px, 1fr) minmax(320px, 520px); gap:24px; max-width:1100px; margin:auto; } @media(max-width:750px){.review-grid{grid-template-columns:1fr}} .companion-review > header button { border:1px solid currentColor; border-radius:6px; padding:6px 10px; margin:8px 8px 12px 0; }`}</style>
    <header><h1>SYNTRA · Komponentenprüfung</h1><p>Lokale Testdaten · keine Anmeldung oder Geschäftsaktionen</p>
      <button onClick={start}>Testantwort starten</button><button onClick={() => setState("listening")}>Zuhören</button><button onClick={() => setState("speaking")}>Sprechen</button><button onClick={() => setState("idle")}>Ruhe</button>
    </header>
    <div className="review-grid"><div style={{position:"relative",height:560, "--avatar-viewport-height":"560px", "--avatar-panel-overlap":"0px"} as React.CSSProperties}>
      <AvatarStage companionState={state} expanded manifest={avatar.manifest} onDragStart={() => {}} />
    </div><ChatPanel draft={draft} isExpanded isRecording={false} uiTheme={theme} sizePreset={size} ttsEnabled={false}
      backendConnectionState="connected" backendConnectionLabel="Lokale Vorschau" messages={messages} onDraftChange={setDraft} onSubmit={start}
      onToggleExpanded={() => {}} onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")} onToggleTts={() => {}}
      onToggleRecording={() => {}} onSelectSizePreset={setSize} onRetry={start} onDragStart={() => {}}
      locale={locale} supportedLocales={["de","en"]} onSelectLocale={next => {setLocale(next);chooseLocale(next);}}
      selectedTtsVoice={voice} ttsVoices={["shimmer", "onyx"]} onSelectTtsVoice={setVoice}
      avatarPreference={avatar.selection} onSelectAvatar={avatar.select} canStopOutput={streaming} onStopOutput={stop}
      onClearConversation={() => {setStreaming(false);setMessages([]);}} />
    </div>
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Preview />);

if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
