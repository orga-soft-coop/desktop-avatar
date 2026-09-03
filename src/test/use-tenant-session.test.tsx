import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAvatarTenantSession } from "../lib/auth-contracts";
import { setLocale } from "../lib/i18n";
import { getRequiredTenantContextId } from "../lib/tenant-session";

const mocks = vi.hoisted(() => ({
  authSessionGet: vi.fn(),
  authPreauthenticate: vi.fn(),
  authCompanies: vi.fn(),
  authBranches: vi.fn(),
  authComplete: vi.fn(),
  authLogout: vi.fn(),
  invalidationListener: null as (() => void) | null
}));

vi.mock("../lib/tauri", () => ({
  authSessionGet: mocks.authSessionGet,
  authPreauthenticate: mocks.authPreauthenticate,
  authCompanies: mocks.authCompanies,
  authBranches: mocks.authBranches,
  authComplete: mocks.authComplete,
  authLogout: mocks.authLogout,
  onTenantSessionInvalidated: (listener: () => void) => {
    mocks.invalidationListener = listener;
    return () => {
      if (mocks.invalidationListener === listener) mocks.invalidationListener = null;
    };
  }
}));

import { useTenantSession } from "../hooks/useTenantSession";

function activeSession(contextId = "context-a"): DesktopAvatarTenantSession {
  const tenant = {
    tenantId: "tenant-a",
    companyId: "100",
    companyName: "Company A",
    branchId: "200",
    branchName: "Branch A",
    canAdminister: true
  };
  return {
    contextId,
    localEpoch: 1,
    publicSession: {
      sessionId: "session-a",
      user: { id: "user-a", username: "alice", globalAuthorities: [] },
      selectedTenant: tenant,
      accessibleTenants: [tenant],
      administrableTenantIds: [tenant.tenantId],
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  };
}

describe("useTenantSession", () => {
  beforeEach(() => {
    setLocale("de");
    mocks.authSessionGet.mockReset();
    mocks.authPreauthenticate.mockReset();
    mocks.authCompanies.mockReset();
    mocks.authBranches.mockReset();
    mocks.authComplete.mockReset();
    mocks.authLogout.mockReset();
    mocks.invalidationListener = null;
    mocks.authSessionGet.mockRejectedValue({ code: "AUTH_SESSION_REQUIRED", message: "Login" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the active Agent Studio tenant session", async () => {
    mocks.authSessionGet.mockResolvedValueOnce(activeSession());
    const { result } = renderHook(() => useTenantSession());

    await waitFor(() => expect(result.current.session?.contextId).toBe("context-a"));
    expect(getRequiredTenantContextId()).toBe("context-a");
  });

  it("recovers an existing native session after a transient bootstrap failure", async () => {
    mocks.authSessionGet
      .mockRejectedValueOnce({
        code: "AUTH_OCWS_UNAVAILABLE",
        message: "Agent Studio unavailable"
      })
      .mockResolvedValueOnce(activeSession());
    const { result } = renderHook(() => useTenantSession());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.sessionRecoveryRequired).toBe(true);
    expect(result.current.error).toBe("SYNTRA unavailable");

    await act(async () => {
      await result.current.retrySession();
    });

    expect(result.current.session?.contextId).toBe("context-a");
    expect(result.current.sessionRecoveryRequired).toBe(false);
    expect(getRequiredTenantContextId()).toBe("context-a");
  });

  it("shows credentials for an initial bodyless session 401", async () => {
    mocks.authSessionGet.mockRejectedValueOnce({ status: 401, code: null, message: "Unauthorized" });
    const { result } = renderHook(() => useTenantSession());

    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.session).toBeNull();
    expect(result.current.step).toBe("credentials");
    expect(result.current.sessionRecoveryRequired).toBe(false);
  });

  it("does not let a stale initial session check overwrite a restarted login", async () => {
    let rejectInitial!: (error: unknown) => void;
    let finishPreauthentication!: () => void;
    mocks.authSessionGet.mockImplementationOnce(
      () => new Promise((_, reject) => {
        rejectInitial = reject;
      })
    );
    mocks.authPreauthenticate.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishPreauthentication = () => resolve({
          status: "PREAUTHENTICATED",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      })
    );
    mocks.authCompanies.mockResolvedValue([{ companyId: "100", companyName: "Company A" }]);
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(mocks.invalidationListener).not.toBeNull());

    act(() => mocks.invalidationListener?.());
    let loginPromise!: Promise<void>;
    act(() => {
      loginPromise = result.current.preauthenticate("alice", "secret");
    });
    expect(result.current.busy).toBe(true);

    await act(async () => {
      rejectInitial({ code: "AUTH_OCWS_UNAVAILABLE", message: "Old bootstrap failure" });
      await Promise.resolve();
    });
    expect(result.current.sessionRecoveryRequired).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(true);

    finishPreauthentication();
    await act(async () => {
      await loginPromise;
    });
    expect(result.current.step).toBe("company");
    expect(result.current.busy).toBe(false);
  });

  it("unmounts an active tenant after a bodyless session 401", async () => {
    mocks.authSessionGet
      .mockResolvedValueOnce(activeSession())
      .mockRejectedValueOnce({ status: 401, code: null, message: "Unauthorized" });
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await result.current.retrySession();
    });

    expect(result.current.session).toBeNull();
    expect(result.current.step).toBe("credentials");
    expect(result.current.sessionRecoveryRequired).toBe(false);
  });

  it("logs out native activity when local expiry meets a session-check outage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const expiring = activeSession();
    expiring.publicSession.expiresAt = "2026-08-25T12:00:01.000Z";
    mocks.authSessionGet
      .mockResolvedValueOnce(expiring)
      .mockRejectedValueOnce({ code: "AUTH_OCWS_UNAVAILABLE", message: "Offline" });
    mocks.authLogout.mockResolvedValue(undefined);
    mocks.authPreauthenticate.mockResolvedValue({
      status: "PREAUTHENTICATED",
      expiresAt: "2026-08-25T12:05:00.000Z"
    });
    mocks.authCompanies.mockResolvedValue([{ companyId: "100", companyName: "Company A" }]);
    const { result } = renderHook(() => useTenantSession());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.session).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(mocks.authLogout).toHaveBeenCalledTimes(1);
    expect(result.current.session).toBeNull();
    expect(result.current.busy).toBe(false);

    await act(async () => {
      await result.current.preauthenticate("alice", "secret");
    });
    expect(result.current.step).toBe("company");
  });

  it("returns an expired login flow to credentials", async () => {
    mocks.authPreauthenticate.mockResolvedValue({ status: "PREAUTHENTICATED", expiresAt: "2099-01-01T00:00:00.000Z" });
    mocks.authCompanies.mockResolvedValue([{ companyId: "100", companyName: "Company A" }]);
    mocks.authBranches.mockRejectedValue({
      code: "AUTH_LOGIN_FLOW_INVALID",
      message: "Login flow expired"
    });
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.preauthenticate("alice", "secret");
    });
    expect(result.current.step).toBe("company");

    await act(async () => {
      await result.current.selectCompany("100");
    });
    expect(result.current.step).toBe("credentials");
    expect(result.current.companies).toEqual([]);
    expect(result.current.branches).toEqual([]);
  });

  it("does not reopen tenant selection from a delayed preauthentication response after invalidation", async () => {
    let finishCompanies!: (companies: Array<{ companyId: string; companyName: string }>) => void;
    mocks.authPreauthenticate.mockResolvedValue({
      status: "PREAUTHENTICATED",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    mocks.authCompanies.mockImplementation(
      () => new Promise((resolve) => {
        finishCompanies = resolve;
      })
    );
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.busy).toBe(false));

    let loginPromise!: Promise<void>;
    act(() => {
      loginPromise = result.current.preauthenticate("alice", "secret");
    });
    await waitFor(() => expect(mocks.authCompanies).toHaveBeenCalledOnce());

    act(() => mocks.invalidationListener?.());
    finishCompanies([{ companyId: "100", companyName: "Company A" }]);
    await act(async () => {
      await loginPromise;
    });

    expect(result.current.step).toBe("credentials");
    expect(result.current.companies).toEqual([]);
    expect(result.current.branches).toEqual([]);
    expect(result.current.busy).toBe(false);
  });

  it("keeps the newest company when branch responses arrive out of order", async () => {
    const resolvers = new Map<
      string,
      (branches: Array<{ companyId: string; branchId: string; branchName: string }>) => void
    >();
    mocks.authPreauthenticate.mockResolvedValue({
      status: "PREAUTHENTICATED",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    mocks.authCompanies.mockResolvedValue([
      { companyId: "100", companyName: "Company A" },
      { companyId: "200", companyName: "Company B" }
    ]);
    mocks.authBranches.mockImplementation(
      (companyId: string) => new Promise((resolve) => resolvers.set(companyId, resolve))
    );
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.preauthenticate("alice", "secret");
    });

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.selectCompany("100");
      secondRequest = result.current.selectCompany("200");
    });
    await waitFor(() => expect(resolvers.size).toBe(2));

    resolvers.get("200")?.([
      { companyId: "200", branchId: "1", branchName: "Branch B" }
    ]);
    await act(async () => {
      await secondRequest;
    });
    expect(result.current.selectedCompanyId).toBe("200");
    expect(result.current.branches).toEqual([
      { companyId: "200", branchId: "1", branchName: "Branch B" }
    ]);

    resolvers.get("100")?.([
      { companyId: "100", branchId: "1", branchName: "Branch A" }
    ]);
    await act(async () => {
      await firstRequest;
    });
    expect(result.current.selectedCompanyId).toBe("200");
    expect(result.current.branches).toEqual([
      { companyId: "200", branchId: "1", branchName: "Branch B" }
    ]);
    expect(result.current.step).toBe("branch");
  });

  it("returns every failed complete attempt to credentials", async () => {
    mocks.authPreauthenticate.mockResolvedValue({
      status: "PREAUTHENTICATED",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    mocks.authCompanies.mockResolvedValue([{ companyId: "100", companyName: "Company A" }]);
    mocks.authBranches.mockResolvedValue([
      { companyId: "100", branchId: "200", branchName: "Branch A" }
    ]);
    mocks.authComplete.mockRejectedValue({
      code: "AUTH_OCWS_UNAVAILABLE",
      message: "Agent Studio unavailable"
    });
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.busy).toBe(false));

    await act(async () => {
      await result.current.preauthenticate("alice", "secret");
      await result.current.selectCompany("100");
      await result.current.selectBranch("200");
    });

    expect(result.current.step).toBe("credentials");
    expect(result.current.companies).toEqual([]);
    expect(result.current.branches).toEqual([]);
  });

  it("invalidates local work before the remote logout finishes", async () => {
    let finishLogout!: () => void;
    mocks.authSessionGet.mockResolvedValueOnce(activeSession());
    mocks.authLogout.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishLogout = resolve;
      })
    );
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    let logoutPromise!: Promise<void>;
    act(() => {
      logoutPromise = result.current.logout();
    });

    expect(result.current.session).toBeNull();
    expect(() => getRequiredTenantContextId()).toThrow("DESKTOP_SESSION_CHANGED");

    finishLogout();
    await act(async () => {
      await logoutPromise;
    });
  });

  it("reacts immediately to a native session invalidation event", async () => {
    mocks.authSessionGet.mockResolvedValueOnce(activeSession());
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    act(() => mocks.invalidationListener?.());

    expect(result.current.session).toBeNull();
    expect(result.current.step).toBe("credentials");
  });

  it("does not install a delayed completed login after native invalidation", async () => {
    let finishComplete!: (session: DesktopAvatarTenantSession) => void;
    mocks.authPreauthenticate.mockResolvedValue({
      status: "PREAUTHENTICATED",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    mocks.authCompanies.mockResolvedValue([{ companyId: "100", companyName: "Company A" }]);
    mocks.authBranches.mockResolvedValue([
      { companyId: "100", branchId: "200", branchName: "Branch A" }
    ]);
    mocks.authComplete.mockImplementation(
      () => new Promise((resolve) => {
        finishComplete = resolve;
      })
    );
    const { result } = renderHook(() => useTenantSession());
    await waitFor(() => expect(result.current.busy).toBe(false));
    await act(async () => {
      await result.current.preauthenticate("alice", "secret");
      await result.current.selectCompany("100");
    });

    let completePromise!: Promise<void>;
    act(() => {
      completePromise = result.current.selectBranch("200");
    });
    await waitFor(() => expect(mocks.authComplete).toHaveBeenCalledOnce());
    act(() => mocks.invalidationListener?.());
    finishComplete(activeSession("stale-context"));
    await act(async () => {
      await completePromise;
    });

    expect(result.current.session).toBeNull();
    expect(result.current.step).toBe("credentials");
    expect(result.current.busy).toBe(false);
  });

  it("localizes generic and invalidated-session errors in English", async () => {
    setLocale("en");
    mocks.authSessionGet.mockRejectedValueOnce({});
    const first = renderHook(() => useTenantSession());
    await waitFor(() => expect(first.result.current.busy).toBe(false));
    expect(first.result.current.error).toBe("SYNTRA is currently unavailable.");
    first.unmount();

    mocks.authSessionGet.mockResolvedValueOnce(activeSession());
    const second = renderHook(() => useTenantSession());
    await waitFor(() => expect(second.result.current.session).not.toBeNull());
    act(() => mocks.invalidationListener?.());
    expect(second.result.current.error).toBe(
      "The SYNTRA session is no longer valid. Please sign in again."
    );
  });
});
