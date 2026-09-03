import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHitlPanelDismissals } from "../hooks/useHitlPanelDismissals";

describe("useHitlPanelDismissals", () => {
  it("dismisses locally and restores pending decisions after peek and reopen", () => {
    const pendingDecision = { decisionId: "decision-a" };
    const { result, rerender } = renderHook(
      ({ expanded }) => useHitlPanelDismissals([pendingDecision], expanded),
      { initialProps: { expanded: true } }
    );

    act(() => result.current.dismissDecision(pendingDecision.decisionId));
    expect(result.current.dismissedDecisionIds).toContain(pendingDecision.decisionId);

    rerender({ expanded: false });
    expect(result.current.dismissedDecisionIds).toContain(pendingDecision.decisionId);

    rerender({ expanded: true });
    expect(result.current.dismissedDecisionIds).not.toContain(pendingDecision.decisionId);
  });

  it("prunes dismissals after the live decision disappears", () => {
    const pendingDecision = { decisionId: "decision-a" };
    const { result, rerender } = renderHook(
      ({ decisions }) => useHitlPanelDismissals(decisions, true),
      { initialProps: { decisions: [pendingDecision] } }
    );

    act(() => result.current.dismissDecision(pendingDecision.decisionId));
    expect(result.current.dismissedDecisionIds).toContain(pendingDecision.decisionId);

    rerender({ decisions: [] });
    expect(result.current.dismissedDecisionIds).toHaveLength(0);
  });
});
