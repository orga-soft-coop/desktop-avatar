import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel, type DevToolsDemoWidgetKind } from "../components/ChatPanel";
import { setLocale } from "../lib/i18n";

function renderChatPanel(
  props: Partial<ComponentProps<typeof ChatPanel>> = {}
) {
  const defaults: ComponentProps<typeof ChatPanel> = {
    draft: "",
    isExpanded: true,
    isRecording: false,
    uiTheme: "light",
    sizePreset: "medium",
    ttsEnabled: true,
    backendConnectionState: "connected",
    backendConnectionLabel: "Verbunden",
    messages: [],
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    onToggleExpanded: vi.fn(),
    onToggleTheme: vi.fn(),
    onToggleTts: vi.fn(),
    onToggleRecording: vi.fn(),
    onSelectSizePreset: vi.fn(),
    onRetry: vi.fn(),
    onDragStart: vi.fn()
  };

  const view = render(<ChatPanel {...defaults} {...props} />);
  return { ...view, rerenderProps: (next: Partial<ComponentProps<typeof ChatPanel>>) =>
    view.rerender(<ChatPanel {...defaults} {...props} {...next} />) };

}

describe("ChatPanel", () => {
  beforeEach(() => {
    setLocale("de");
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a visible empty transcript area before the first message", () => {
    renderChatPanel();

    expect(screen.getByLabelText("Verlauf")).toBeInTheDocument();
    expect(screen.getByText("Noch kein Chatverlauf.")).toBeInTheDocument();
  });

  it("preserves the reading position during streaming and resumes following on demand", async () => {
    const message = { id: "answer", role: "assistant" as const, text: "Beginning", createdAt: "2026-09-06", source: "text" as const, isStreaming: true };
    const view = renderChatPanel({ messages: [message] });
    const list = view.container.querySelector(".chat-panel__messages")!;
    Object.defineProperties(list, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 200 } });
    list.scrollTop = 100;
    fireEvent.scroll(list);
    view.rerenderProps({ messages: [{ ...message, text: "Beginning of the answer" }] });
    expect(list.scrollTop).toBe(100);
    await userEvent.click(screen.getByRole("button", { name: "Neue Antwort ↓" }));
    expect(list.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Neue Antwort ↓" })).not.toBeInTheDocument();
    Object.defineProperty(list, "scrollHeight", { value: 1200 });
    view.rerenderProps({ messages: [{ ...message, text: "Complete answer", isStreaming: false }] });
    expect(list.scrollTop).toBe(1200);
    view.rerenderProps({ messages: [] });
    expect(screen.queryByRole("button", { name: "Neue Antwort ↓" })).not.toBeInTheDocument();
  });

  it("offers language, voice, size and both avatars in settings separately from diagnostics", async () => {
    const onSelectAvatar = vi.fn();
    const onSelectLocale = vi.fn();
    const onSelectTtsVoice = vi.fn();
    const onSelectSizePreset = vi.fn();
    renderChatPanel({ avatarPreference: "female_avatar_1", onSelectAvatar, onSelectLocale, supportedLocales: ["de", "en"], onSelectTtsVoice, ttsVoices: ["shimmer"], onSelectSizePreset });
    await userEvent.click(screen.getByRole("button", { name: "Einstellungen" }));
    await userEvent.selectOptions(screen.getByLabelText("Sprache"), "en");
    await userEvent.selectOptions(screen.getByLabelText("Stimme"), "shimmer");
    await userEvent.selectOptions(screen.getByLabelText("Größe"), "small");
    await userEvent.click(screen.getByLabelText("Female Avatar 2"));
    expect(onSelectLocale).toHaveBeenCalledWith("en");
    expect(onSelectTtsVoice).toHaveBeenCalledWith("shimmer");
    expect(onSelectSizePreset).toHaveBeenCalledWith("small");
    expect(onSelectAvatar).toHaveBeenCalledWith("female_avatar_2");
    expect(screen.queryByRole("button", { name: "Entwicklerwerkzeuge" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Female Avatar 1" })).toBeChecked();
  });

  it("offers stopping output without clearing the conversation, including an empty stopped answer", async () => {
    const onStopOutput = vi.fn();
    const onClearConversation = vi.fn();
    const view = renderChatPanel({ canStopOutput: true, onStopOutput, onClearConversation });
    await userEvent.click(screen.getByRole("button", { name: "Stoppen" }));
    expect(onStopOutput).toHaveBeenCalledOnce();
    expect(onClearConversation).not.toHaveBeenCalled();
    view.rerenderProps({ canStopOutput: false, messages: [{ id: "stopped", role: "assistant", text: "", createdAt: "2026-09-06", source: "text", outputStopped: true }] });
    expect(screen.getByText("Ausgabe gestoppt.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Senden" })).toBeInTheDocument();
  });

  it("exposes HITL and operator radar demo widgets in developer tools", async () => {
    const onToggleDemoWidget = vi.fn<(kind: DevToolsDemoWidgetKind) => void>();
    renderChatPanel({ onToggleDemoWidget });

    await userEvent.click(screen.getByRole("button", { name: "Entwicklerwerkzeuge" }));
    await userEvent.click(screen.getByRole("button", { name: "HITL" }));
    await userEvent.click(screen.getByRole("button", { name: "Radar" }));

    expect(onToggleDemoWidget).toHaveBeenCalledWith("hitlApproval");
    expect(onToggleDemoWidget).toHaveBeenCalledWith("operatorRadar");
  });

  it("preserves open diagnostics across Peek collapse and reopen", async () => {
    const view = renderChatPanel({ onToggleDemoWidget: vi.fn() });
    await userEvent.click(screen.getByRole("button", { name: "Entwicklerwerkzeuge" }));
    expect(screen.getByRole("button", { name: "HITL" })).toBeInTheDocument();
    view.rerenderProps({ isExpanded: false });
    expect(screen.queryByRole("button", { name: "HITL" })).not.toBeInTheDocument();
    view.rerenderProps({ isExpanded: true });
    expect(screen.getByRole("button", { name: "HITL" })).toBeInTheDocument();
  });

  it("exposes radar scenario player entries in developer tools", async () => {
    const onToggleDemoWidget = vi.fn<(kind: DevToolsDemoWidgetKind) => void>();
    renderChatPanel({ onToggleDemoWidget });

    await userEvent.click(screen.getByRole("button", { name: "Entwicklerwerkzeuge" }));
    expect(screen.getByText("Radar-Szenarien")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Forecast läuft" }));
    await userEvent.click(screen.getByRole("button", { name: "Run fehlgeschlagen" }));

    expect(onToggleDemoWidget).toHaveBeenCalledWith("radarForecastRunning");
    expect(onToggleDemoWidget).toHaveBeenCalledWith("radarRunFailed");
  });
});
