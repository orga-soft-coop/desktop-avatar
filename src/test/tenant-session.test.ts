import { afterEach, describe, expect, it } from "vitest";
import type { DesktopAvatarTenantSession } from "../lib/auth-contracts";
import {
  activateTenantSession,
  clearTenantSession,
  getRequiredTenantContextId,
  isCurrentTenantContext
} from "../lib/tenant-session";

function session(contextId: string, tenantId: string): DesktopAvatarTenantSession {
  const tenant = {
    tenantId,
    companyId: "same-company-id",
    companyName: `Company ${tenantId}`,
    branchId: "same-branch-id",
    branchName: `Branch ${tenantId}`,
    canAdminister: true
  };
  return {
    contextId,
    localEpoch: contextId === "context-a" ? 1 : 2,
    publicSession: {
      sessionId: `session-${tenantId}`,
      user: { id: "user", username: "alice", globalAuthorities: [] },
      selectedTenant: tenant,
      accessibleTenants: [tenant],
      administrableTenantIds: [tenantId],
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  };
}

describe("tenant-session", () => {
  afterEach(clearTenantSession);

  it("replaces the immutable context even when company and branch ids are identical", () => {
    const first = activateTenantSession(session("context-a", "tenant-a"));
    const second = activateTenantSession(session("context-b", "tenant-b"));

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.publicSession)).toBe(true);
    expect(Object.isFrozen(first.publicSession.user)).toBe(true);
    expect(Object.isFrozen(first.publicSession.user.globalAuthorities)).toBe(true);
    expect(Object.isFrozen(first.publicSession.selectedTenant)).toBe(true);
    expect(Object.isFrozen(first.publicSession.accessibleTenants)).toBe(true);
    expect(Object.isFrozen(first.publicSession.accessibleTenants[0])).toBe(true);
    expect(Object.isFrozen(first.publicSession.administrableTenantIds)).toBe(true);
    expect(isCurrentTenantContext("context-a")).toBe(false);
    expect(isCurrentTenantContext("context-b")).toBe(true);
    expect(getRequiredTenantContextId()).toBe(second.contextId);
  });

  it("rejects all work immediately after logout clearing", () => {
    activateTenantSession(session("context-a", "tenant-a"));
    clearTenantSession();
    expect(() => getRequiredTenantContextId()).toThrow("DESKTOP_SESSION_CHANGED");
  });
});
