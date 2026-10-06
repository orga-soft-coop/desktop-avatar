import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LearningReviewPanel } from "../components/LearningReviewPanel";
import type { LearningReviewDetail } from "../lib/learning-review-contracts";
import { activateTenantSession, clearTenantSession } from "../lib/tenant-session";
import { setLocale } from "../lib/i18n";

function session(contextId = "a") {
  const tenant = { tenantId: `tenant-${contextId}`, companyId: "701", companyName: "Company", branchId: "1", branchName: "Branch", canAdminister: false };
  activateTenantSession({ contextId, localEpoch: 1, publicSession: { sessionId: contextId, user: { id: `owner-${contextId}`, username: "user", globalAuthorities: [] }, selectedTenant: tenant, accessibleTenants: [tenant], administrableTenantIds: [], expiresAt: "2099-01-01T00:00:00.000Z" } });
}
function fixture(context = "a", status: LearningReviewDetail["review"]["status"] = "PENDING"): LearningReviewDetail {
  return {
    review: { id: `review-${context}`, version: 1, currentRevisionId: `revision-${context}`, status, purpose: "TASK", source: "HITL_HUMAN", access: "SOURCE_OWNER", tenantId: `tenant-${context}`, ownerUserId: `owner-${context}`, agentId: `agent-${context}`, mode: "SIMULATION", sourceEventId: `event-${context}`, sourceRunId: `run-${context}`, sourceProposalId: `proposal-${context}`, createdAt: "2026-10-02T10:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z" },
    revision: { id: `revision-${context}`, reviewId: `review-${context}`, version: 1, status, purpose: "TASK", body: `Private case ${context}`, bodySha256: "1".repeat(64), createdAt: "2026-10-02T10:00:00.000Z" },
    originalFeedback: { eventId: `event-${context}`, runId: `run-${context}`, proposalId: `proposal-${context}`, approved: true, decisionReason: `Original unchanged ${context}`, actorUserId: `human-${context}`, decidedAt: "2026-10-02T10:00:00.000Z", scope: "single", auditSource: "api", learningCaptureStatus: "CAPTURED" }
  };
}
function apiFor(context = "a") {
  const value = fixture(context);
  return {
    list: vi.fn().mockResolvedValue({ items: [{ ...value.review, bodyPreview: `Case summary ${context}` }] }),
    get: vi.fn().mockResolvedValue(value),
    decide: vi.fn().mockResolvedValue({ ...value, review: { ...value.review, status: "CONFIRMED", version: 2 }, revision: { ...value.revision, status: "CONFIRMED", version: 2 } }),
    revoke: vi.fn().mockResolvedValue(fixture(context, "REVOKED"))
  };
}
async function selectCase() { await userEvent.click(await screen.findByRole("button", { name: /Case summary/ })); await screen.findByText("Private case a"); }
afterEach(() => { cleanup(); clearTenantSession(); });
beforeEach(() => { setLocale("de"); session(); });

describe("private learning reviews", () => {
  it("requires explicit assessment and reason even when original business feedback approved", async () => {
    const api = apiFor(); render(<LearningReviewPanel contextId="a" api={api} />); await selectCase();
    const confirm = screen.getByRole("button", { name: "Bestätigen" }); expect(confirm).toBeDisabled();
    expect(screen.getByLabelText("Explizite Bewertung des ursprünglichen Falls")).toHaveValue("");
    await userEvent.type(screen.getByLabelText("Prüf- oder Widerrufsgrund"), "Case checked"); expect(confirm).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Explizite Bewertung des ursprünglichen Falls"), "NEGATIVE");
    await userEvent.click(confirm);
    await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(1));
    expect(api.decide.mock.calls[0]).toEqual(["review-a", { expectedVersion: 1, decision: "CONFIRM", reason: "Case checked", caseAssessment: "NEGATIVE" }, expect.stringMatching(/^learning-/), "a"]);
    expect(api.revoke).not.toHaveBeenCalled();
  });
  it("keeps an adjustment local and preserves it after a version conflict", async () => {
    const api = apiFor(); const existing = fixture(); existing.revision.validUntil = "2027-01-01T12:00:00.000Z";
    api.get.mockResolvedValue(existing); api.decide.mockRejectedValue(JSON.stringify({ status: 409, code: "CONFLICT", message: "Version changed" })); render(<LearningReviewPanel contextId="a" api={api} />); await selectCase();
    await userEvent.click(screen.getByRole("button", { name: "Anpassen" }));
    await userEvent.clear(screen.getByLabelText("Erfahrungstext")); await userEvent.type(screen.getByLabelText("Erfahrungstext"), "Justified adjusted experience");
    await userEvent.selectOptions(screen.getByLabelText("Verwendungszweck"), "COMPANY");
    await userEvent.clear(screen.getByLabelText("Gültig bis"));
    await userEvent.selectOptions(screen.getByLabelText("Explizite Bewertung des ursprünglichen Falls"), "CORRECTION");
    await userEvent.type(screen.getByLabelText("Prüf- oder Widerrufsgrund"), "Explained adjustment");
    expect(api.decide).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern und bestätigen" }));
    await screen.findByRole("alert"); expect(screen.getByLabelText("Erfahrungstext")).toHaveValue("Justified adjusted experience");
    expect(api.decide.mock.calls[0]?.[1]).toEqual({ expectedVersion: 1, decision: "ADJUST", reason: "Explained adjustment", caseAssessment: "CORRECTION", body: "Justified adjusted experience", purpose: "COMPANY", validFrom: null, validUntil: null });
    expect(screen.getByRole("button", { name: "Aktuelle Fassung laden (Entwurf verwerfen)" })).toBeInTheDocument();
    await userEvent.click(screen.getByText("Unverändertes Originalfeedback")); expect(screen.getByText("Original unchanged a")).toBeInTheDocument();
  });
  it("reuses the idempotency key for the same failed submission", async () => {
    const api = apiFor(); api.decide.mockRejectedValueOnce(new Error("network")); render(<LearningReviewPanel contextId="a" api={api} />); await selectCase();
    await userEvent.selectOptions(screen.getByLabelText("Explizite Bewertung des ursprünglichen Falls"), "UNASSESSED"); await userEvent.type(screen.getByLabelText("Prüf- oder Widerrufsgrund"), "Permitted case");
    await userEvent.click(screen.getByRole("button", { name: "Bestätigen" })); await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Bestätigen" })); await waitFor(() => expect(api.decide).toHaveBeenCalledTimes(2));
    expect(api.decide.mock.calls[0]).toEqual(api.decide.mock.calls[1]);
  });
  it("clears private detail, draft and list when current access is lost", async () => {
    const api = apiFor(); render(<LearningReviewPanel contextId="a" api={api} />); await selectCase();
    await userEvent.click(screen.getByRole("button", { name: "Anpassen" })); api.list.mockRejectedValue(JSON.stringify({ status: 403, code: "FORBIDDEN", message: "Access removed" }));
    await userEvent.click(screen.getByRole("button", { name: "Aktualisieren" })); await screen.findByRole("alert");
    expect(screen.queryByText("Private case a")).toBeNull(); expect(screen.queryByLabelText("Erfahrungstext")).toBeNull(); expect(screen.queryByText("Case summary a")).toBeNull();
    expect(screen.queryByText("Wird geladen …")).toBeNull();
  });
  it("drops a pending old-context detail and synchronously resets when tenant context changes", async () => {
    const api = apiFor(); let resolveOld!: (value: LearningReviewDetail) => void;
    api.get.mockImplementationOnce(() => new Promise<LearningReviewDetail>(resolve => { resolveOld = resolve; }));
    const view = render(<LearningReviewPanel contextId="a" api={api} />); await userEvent.click(await screen.findByRole("button", { name: /Case summary/ }));
    session("b"); const apiB = apiFor("b"); view.rerender(<LearningReviewPanel contextId="b" api={apiB} />);
    await act(async () => resolveOld(fixture()));
    expect(screen.queryByText("Private case a")).toBeNull(); expect(screen.queryByText("Case summary a")).toBeNull();
    expect(await screen.findByText("Case summary b")).toBeInTheDocument();
    expect(apiB.list).toHaveBeenCalledWith({ limit: 20, status: "PENDING" }, "b");
  });
  it("lists rejected and revoked in the discarded view and never calls a business action", async () => {
    const api = apiFor(); api.list.mockResolvedValue({ items: [] }); render(<LearningReviewPanel contextId="a" api={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Verworfen" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ limit: 20, status: "REVOKED" }, "a"));
    expect(api.list).toHaveBeenCalledWith({ limit: 20, status: "REJECTED" }, "a");
    expect(api.decide).not.toHaveBeenCalled(); expect(api.revoke).not.toHaveBeenCalled();
    expect(within(screen.getByRole("region", { name: "Lernprüfungen" })).queryByRole("button", { name: /Genehmigen|Ausführen|Archiv/ })).toBeNull();
  });
});
