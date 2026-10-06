import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
import { decideLearningReview, getLearningReview, listLearningReviews, revokeLearningReview } from "../lib/tauri";
import { activateTenantSession, clearTenantSession } from "../lib/tenant-session";
function session(contextId = "a") {
  const tenant = { tenantId: `tenant-${contextId}`, companyId: "701", companyName: "Company", branchId: "1", branchName: "Branch", canAdminister: false };
  activateTenantSession({ contextId, localEpoch: 1, publicSession: { sessionId: contextId, user: { id: `owner-${contextId}`, username: "user", globalAuthorities: [] }, selectedTenant: tenant, accessibleTenants: [tenant], administrableTenantIds: [], expiresAt: "2099-01-01T00:00:00.000Z" } });
}
afterEach(() => { clearTenantSession(); delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
beforeEach(() => { mock.invoke.mockReset(); (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}; session(); });
describe("native learning transport", () => {
  it("uses only learning commands with captured context, revision and submitted idempotency key", async () => {
    mock.invoke.mockResolvedValue({});
    await listLearningReviews({ status: "PENDING", limit: 20 }, "a");
    await getLearningReview("review/a", 2, "a");
    const input = { expectedVersion: 2, decision: "ADJUST" as const, reason: "checked", caseAssessment: "UNASSESSED" as const, body: "case", purpose: "COMPANY" as const };
    await decideLearningReview("review/a", input, "learning-key", "a");
    await revokeLearningReview("review/a", { expectedVersion: 3, reason: "withdrawn" }, "revoke-key", "a");
    expect(mock.invoke.mock.calls).toEqual([
      ["learning_reviews_list", { query: { status: "PENDING", limit: 20 }, expectedContextId: "a" }],
      ["learning_review_get", { reviewId: "review/a", version: 2, expectedContextId: "a" }],
      ["learning_review_decide", { reviewId: "review/a", input, idempotencyKey: "learning-key", expectedContextId: "a" }],
      ["learning_review_revoke", { reviewId: "review/a", input: { expectedVersion: 3, reason: "withdrawn" }, idempotencyKey: "revoke-key", expectedContextId: "a" }]
    ]);
  });
  it("rejects a stale context before IPC and drops a late successful reply", async () => {
    await expect(listLearningReviews({}, "foreign")).rejects.toThrow("DESKTOP_SESSION_CHANGED");
    expect(mock.invoke).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    mock.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = getLearningReview("private-a", undefined, "a"); session("b"); finish({ private: "old context" });
    await expect(pending).rejects.toThrow("DESKTOP_SESSION_CHANGED");
  });
  it("drops a late error after logout and has no browser fallback", async () => {
    let reject!: (error: unknown) => void;
    mock.invoke.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const pending = listLearningReviews({}, "a"); clearTenantSession(); reject({ status: 403 });
    await expect(pending).rejects.toThrow("DESKTOP_SESSION_CHANGED");
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    session(); await expect(listLearningReviews({}, "a")).rejects.toThrow();
    expect(mock.invoke).toHaveBeenCalledTimes(1);
  });
});
