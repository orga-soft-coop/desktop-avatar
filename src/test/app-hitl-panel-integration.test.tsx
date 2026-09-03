import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  session: {
    contextId: "context-a",
    localEpoch: 1,
    publicSession: {
      sessionId: "session-a",
      user: { id: "user-a", username: "INTADMIN", globalAuthorities: [] },
      selectedTenant: {
        tenantId: "tenant-a",
        companyId: "668",
        companyName: "Testmandant Gio",
        branchId: "2",
        branchName: "Fries Idar-Oberstein",
        canAdminister: false
      },
      accessibleTenants: [],
      administrableTenantIds: [],
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  },
  logout: vi.fn().mockResolvedValue(undefined)
}));

const companion = vi.hoisted(() => ({
  activeAnimation: null,
  animationEnabled: true,
  approveHitl: vi.fn(),
  avatarManifest: null,
  backendConnectionState: "connected" as const,
  bootstrapReady: true,
  clearConversation: vi.fn(),
  collapseToPeek: vi.fn(),
  companionState: "idle" as const,
  dismissOperatorRadar: vi.fn(),
  draft: "",
  error: null,
  hitlWidgets: [
    {
      type: "hitlApproval" as const,
      decisionId: "decision-a",
      runId: "run-a",
      proposalId: "proposal-a",
      actionId: "ORDER_ARTICLES",
      title: "FIRST HITL",
      description: "First pending decision.",
      agentName: "Warehouse Agent",
      mode: "SIMULATION" as const,
      status: "pending",
      priority: "high" as const,
      contextSections: []
    },
    {
      type: "hitlApproval" as const,
      decisionId: "decision-b",
      runId: "run-b",
      proposalId: "proposal-b",
      actionId: "ORDER_ARTICLES",
      title: "SECOND HITL",
      description: "Second pending decision.",
      agentName: "Warehouse Agent",
      mode: "SIMULATION" as const,
      status: "pending",
      priority: "high" as const,
      contextSections: []
    }
  ],
  isModeTransitioning: false,
  isRecording: false,
  latencyDebug: null,
  locale: "de" as const,
  messages: [],
  modeTransitionPhase: "idle" as const,
  notifyOperatorRadarSignalOnCompletion: vi.fn(),
  openAgent: vi.fn(),
  openHitl: vi.fn(),
  openOperatorRadar: vi.fn(),
  operatorRadarSignalCount: 0,
  operatorRadarWidget: null,
  peekMode: "expanded" as "expanded" | "peek",
  rejectHitl: vi.fn(),
  requestMoreInfoForHitl: vi.fn(),
  resizeWindow: vi.fn().mockResolvedValue(undefined),
  selectLocale: vi.fn(),
  selectedTtsVoice: null,
  selectTranscriptionProvider: vi.fn(),
  selectTtsVoice: vi.fn(),
  setDraft: vi.fn(),
  setPeekPosition: vi.fn(),
  setSizePreset: vi.fn(),
  sizePreset: "medium" as const,
  snoozeOperatorRadarSignal: vi.fn(),
  startWindowDrag: vi.fn(),
  status: null,
  submitCurrentDraft: vi.fn(),
  submitSuggestion: vi.fn(),
  supportedLocales: ["de"],
  toggleExpanded: vi.fn(),
  toggleFollowOperatorRadarSignal: vi.fn(),
  toggleRecording: vi.fn(),
  toggleTts: vi.fn(),
  transcriptionProvider: "openai-realtime" as const,
  transcriptionProviders: [],
  ttsEnabled: false,
  ttsVoices: [],
  windowSize: { width: 1140, height: 620 }
}));

const initialHitlWidgets = companion.hitlWidgets.map((widget) => ({ ...widget }));

vi.mock("../hooks/useTenantSession", () => ({
  useTenantSession: () => auth
}));

vi.mock("../hooks/useDesktopCompanion", () => ({
  useDesktopCompanion: () => companion
}));

vi.mock("../lib/tauri", () => ({
  getWindowGeometry: vi.fn().mockResolvedValue(null)
}));

vi.mock("../components/AvatarStage", () => ({
  AvatarStage: () => <div />
}));

vi.mock("../components/SpeechBubble", () => ({
  SpeechBubble: () => <div />
}));

vi.mock("../components/ChatPanel", () => ({
  ChatPanel: () => <div />
}));

import App from "../App";

describe("App HITL panel integration", () => {
  afterEach(() => {
    cleanup();
    companion.peekMode = "expanded";
    companion.hitlWidgets = initialHitlWidgets.map((widget) => ({ ...widget }));
    vi.clearAllMocks();
  });

  it("dismisses panels locally and restores pending HITLs after reopen", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(<App />);

    expect(await screen.findByText("SECOND HITL")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schließen" }));

    expect(await screen.findByText("FIRST HITL")).toBeInTheDocument();
    expect(screen.queryByText("SECOND HITL")).toBeNull();
    expect(companion.hitlWidgets).toHaveLength(2);
    expect(companion.approveHitl).not.toHaveBeenCalled();
    expect(companion.rejectHitl).not.toHaveBeenCalled();
    expect(companion.requestMoreInfoForHitl).not.toHaveBeenCalled();

    companion.hitlWidgets = [
      ...companion.hitlWidgets,
      {
        ...companion.hitlWidgets[0]!,
        decisionId: "decision-c",
        runId: "run-c",
        proposalId: "proposal-c",
        title: "THIRD HITL"
      }
    ];
    rerender(<App />);
    expect(await screen.findByText("THIRD HITL")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Alle schließen" }));
    await waitFor(() => expect(screen.queryByText("THIRD HITL")).toBeNull());
    expect(companion.hitlWidgets).toHaveLength(3);

    companion.peekMode = "peek";
    rerender(<App />);
    expect(container.querySelector(".peek-backend-connection-dot__count")).toHaveTextContent("3");

    companion.peekMode = "expanded";
    rerender(<App />);
    expect(await screen.findByText("THIRD HITL")).toBeInTheDocument();
    expect(companion.hitlWidgets).toHaveLength(3);
    expect(companion.approveHitl).not.toHaveBeenCalled();
    expect(companion.rejectHitl).not.toHaveBeenCalled();
  });
});
