import { cleanup, render, screen } from "@testing-library/react";
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

  return render(<ChatPanel {...defaults} {...props} />);
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

  it("exposes HITL and operator radar demo widgets in developer tools", async () => {
    const onToggleDemoWidget = vi.fn<(kind: DevToolsDemoWidgetKind) => void>();
    renderChatPanel({ onToggleDemoWidget });

    await userEvent.click(screen.getByRole("button", { name: "Entwicklerwerkzeuge" }));
    await userEvent.click(screen.getByRole("button", { name: "HITL" }));
    await userEvent.click(screen.getByRole("button", { name: "Radar" }));

    expect(onToggleDemoWidget).toHaveBeenCalledWith("hitlApproval");
    expect(onToggleDemoWidget).toHaveBeenCalledWith("operatorRadar");
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
