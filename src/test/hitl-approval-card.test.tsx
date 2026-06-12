import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAvatarWidgetPanel } from "../components/DesktopAvatarWidgetPanel";
import type { DesktopAvatarHitlApprovalWidget } from "../lib/contracts";

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
});
