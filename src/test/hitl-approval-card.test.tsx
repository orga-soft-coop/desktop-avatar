import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAvatarWidgetPanel } from "../components/DesktopAvatarWidgetPanel";
import type {
  DesktopAvatarHitlApprovalWidget,
  DesktopAvatarOperatorRadarWidget
} from "../lib/contracts";

function widget(mode: "SIMULATION" | "EXECUTION"): DesktopAvatarHitlApprovalWidget {
  return {
    type: "hitlApproval",
    decisionId: "proposal::run%3A1::proposal%3A1",
    runId: "run:1",
    proposalId: "proposal:1",
    actionId: "PURCHASE_ORDER",
    title: "PURCHASE ORDER",
    description: "Supplier order needs approval.",
    agentName: "Purchase Agent",
    mode,
    status: "pending",
    priority: "high",
    contextSections: [],
  };
}

function radarWidget(): DesktopAvatarOperatorRadarWidget {
  return {
    type: "operatorRadar",
    title: "Operator-Radar",
    generatedAt: "2026-06-14T09:00:00.000Z",
    summary: {
      totalCount: 2,
      criticalCount: 1,
      highCount: 0,
      needsApprovalCount: 1,
      runningCount: 1,
      failedCount: 0,
      topSignalId: "radar:hitl:decision-1"
    },
    items: [
      {
        signalId: "radar:hitl:decision-1",
        kind: "hitlApproval",
        severity: "critical",
        status: "needsApproval",
        title: "Bestellung freigeben",
        description: "Eine Bestellung wartet auf Freigabe.",
        studioAgentId: "studio-agent:purchase",
        agentName: "Purchase Agent",
        agentRole: "DOMAIN",
        runId: "run:1",
        proposalId: "proposal:1",
        decisionId: "decision-1",
        actionId: "PURCHASE_ORDER",
        updatedAt: "2026-06-14T09:00:00.000Z",
        audience: {
          scope: "management"
        },
        source: {
          kind: "hitl",
          label: "HITL decision queue",
          runId: "run:1",
          proposalId: "proposal:1",
          decisionId: "decision-1",
          actionId: "PURCHASE_ORDER",
          status: "pending"
        },
        why: "Dieses Signal wird angezeigt, weil eine HITL-Entscheidung aktuell offen ist.",
        timeline: [
          {
            id: "decision-1:decision",
            title: "Freigabe erforderlich",
            timestamp: "2026-06-14T09:00:00.000Z",
            description: "Bestellung freigeben",
            status: "critical"
          }
        ]
      },
      {
        signalId: "radar:runtime:warehouse:running",
        kind: "runtimeRunning",
        severity: "info",
        status: "running",
        title: "Agent arbeitet",
        description: "Ein Runtime-Run ist aktiv.",
        studioAgentId: "studio-agent:warehouse",
        agentName: "Warehouse Agent",
        agentRole: "DOMAIN",
        updatedAt: "2026-06-14T08:59:00.000Z",
        audience: {
          scope: "team"
        }
      }
    ]
  };
}

describe("HITL approval card", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows that the card is a HITL approval and displays priority", () => {
    render(<DesktopAvatarWidgetPanel widget={widget("SIMULATION")} />);

    expect(screen.getByText("HITL-Freigabe")).toBeInTheDocument();
    expect(screen.getByText("Priorität: Hoch")).toBeInTheDocument();
    expect(screen.getByText("Purchase Agent · SIMULATION · Wartet")).toBeInTheDocument();
  });

  it("requires a reason before rejecting", async () => {
    const onReject = vi.fn();
    render(<DesktopAvatarWidgetPanel widget={widget("SIMULATION")} onHitlReject={onReject} />);

    expect(screen.getByRole("button", { name: "Ablehnen" })).toBeDisabled();
    await userEvent.type(
      screen.getByPlaceholderText("Kommentar oder Grund eingeben..."),
      "Missing supplier data",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ablehnen" }));

    expect(onReject).toHaveBeenCalledWith(
      "proposal::run%3A1::proposal%3A1",
      "Missing supplier data",
    );
  });

  it("requires a message before requesting more information", async () => {
    const onRequestMoreInfo = vi.fn();
    render(
      <DesktopAvatarWidgetPanel
        widget={widget("SIMULATION")}
        onHitlRequestMoreInfo={onRequestMoreInfo}
      />,
    );

    expect(screen.getByRole("button", { name: "Rückfrage" })).toBeDisabled();
    await userEvent.type(
      screen.getByPlaceholderText("Kommentar oder Grund eingeben..."),
      "Bitte Lieferantwerk pruefen",
    );
    await userEvent.click(screen.getByRole("button", { name: "Rückfrage" }));

    expect(onRequestMoreInfo).toHaveBeenCalledWith(
      "proposal::run%3A1::proposal%3A1",
      "Bitte Lieferantwerk pruefen",
    );
  });

  it("requires explicit confirmation before EXECUTION approval", async () => {
    const onApprove = vi.fn();
    render(<DesktopAvatarWidgetPanel widget={widget("EXECUTION")} onHitlApprove={onApprove} />);

    expect(screen.getByRole("button", { name: "Freigeben" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await userEvent.click(screen.getByRole("button", { name: "Freigeben" }));

    expect(onApprove).toHaveBeenCalledWith("proposal::run%3A1::proposal%3A1", undefined);
  });

  it("renders the operator radar summary and opens HITL context", async () => {
    const onOpenHitl = vi.fn();
    const onRadarSnooze = vi.fn();
    const onRadarFollowToggle = vi.fn();
    const onRadarCompletionOnly = vi.fn();
    render(
      <DesktopAvatarWidgetPanel
        widget={radarWidget()}
        onOpenHitl={onOpenHitl}
        onRadarSnooze={onRadarSnooze}
        onRadarFollowToggle={onRadarFollowToggle}
        onRadarCompletionOnly={onRadarCompletionOnly}
      />,
    );

    expect(screen.getByText("Operator-Radar")).toBeInTheDocument();
    expect(screen.getByText("2 gesamt")).toBeInTheDocument();
    expect(screen.getAllByText("Bestellung freigeben")).toHaveLength(2);
    expect(screen.getByText("Warehouse Agent")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Details" })[0]!);

    expect(screen.getByText("Warum sehe ich das?")).toBeInTheDocument();
    expect(
      screen.getByText("Dieses Signal wird angezeigt, weil eine HITL-Entscheidung aktuell offen ist."),
    ).toBeInTheDocument();
    expect(screen.getByText("Aktivitätsverlauf")).toBeInTheDocument();
    expect(screen.getByText("HITL decision queue")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "HITL öffnen" }));

    expect(onOpenHitl).toHaveBeenCalledWith("decision-1");

    await userEvent.click(screen.getByRole("button", { name: "10 Min ausblenden" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Beobachten" })[1]!);
    await userEvent.click(screen.getByRole("button", { name: "Bei Abschluss melden" }));

    expect(onRadarSnooze).toHaveBeenCalledWith("radar:runtime:warehouse:running");
    expect(onRadarFollowToggle).toHaveBeenCalledWith("radar:runtime:warehouse:running");
    expect(onRadarCompletionOnly).toHaveBeenCalledWith("radar:runtime:warehouse:running");
  });
});
