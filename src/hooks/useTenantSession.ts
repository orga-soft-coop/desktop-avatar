import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AuthBranchSummary,
  AuthCompanySummary,
  DesktopAvatarTenantSession
} from "../lib/auth-contracts";
import {
  authBranches,
  authCompanies,
  authComplete,
  authLogout,
  onTenantSessionInvalidated,
  authPreauthenticate,
  authSessionGet
} from "../lib/tauri";
import { activateTenantSession, clearTenantSession } from "../lib/tenant-session";
import { t } from "../lib/i18n";
import {
  agentStudioErrorCode,
  requiresFreshAgentStudioLogin
} from "../lib/auth-errors";

type LoginStep = "credentials" | "company" | "branch";

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

function brandSyntraMessage(message: string): string {
  return message.replaceAll("Agent Studio", "SYNTRA").replaceAll("Agent-Studio", "SYNTRA");
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return brandSyntraMessage(message);
  }
  if (typeof error === "string" && error.trim()) return brandSyntraMessage(error);
  return t("auth.unreachable");
}

export function useTenantSession() {
  const [session, setSession] = useState<Readonly<DesktopAvatarTenantSession> | null>(null);
  const [step, setStep] = useState<LoginStep>("credentials");
  const [companies, setCompanies] = useState<AuthCompanySummary[]>([]);
  const [branches, setBranches] = useState<AuthBranchSummary[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [sessionRecoveryRequired, setSessionRecoveryRequired] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const companyRequestRef = useRef(0);

  const installSession = useCallback((next: DesktopAvatarTenantSession) => {
    const installed = activateTenantSession(next);
    setSession(installed);
    setError(null);
    return installed;
  }, []);

  const resetLocal = useCallback(() => {
    generationRef.current += 1;
    companyRequestRef.current += 1;
    clearTenantSession();
    setSession(null);
    setStep("credentials");
    setCompanies([]);
    setBranches([]);
    setSelectedCompanyId("");
    setSessionRecoveryRequired(false);
    setBusy(false);
  }, []);

  useEffect(() => {
    let active = true;
    const generation = generationRef.current;
    void authSessionGet()
      .then((restored) => {
        if (active && generation === generationRef.current) installSession(restored);
      })
      .catch((caught) => {
        if (active && generation === generationRef.current) {
          if (requiresFreshAgentStudioLogin(caught)) {
            resetLocal();
          } else {
            setSessionRecoveryRequired(true);
          }
          setError(messageOf(caught));
        }
      })
      .finally(() => {
        if (active && generation === generationRef.current) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [installSession, resetLocal]);

  const retrySession = useCallback(async () => {
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const restored = await authSessionGet();
      if (generation !== generationRef.current) return;
      installSession(restored);
      setSessionRecoveryRequired(false);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      if (requiresFreshAgentStudioLogin(caught)) {
        resetLocal();
      } else {
        setSessionRecoveryRequired(true);
      }
      setError(messageOf(caught));
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [installSession, resetLocal]);

  useEffect(
    () =>
      onTenantSessionInvalidated(() => {
        resetLocal();
        setError(t("auth.sessionInvalidated"));
      }),
    [resetLocal]
  );

  useEffect(() => {
    if (!session) return;
    const verify = () => {
      const generation = generationRef.current;
      void authSessionGet()
        .then((confirmed) => {
          if (generation === generationRef.current) installSession(confirmed);
        })
        .catch((caught) => {
          if (generation !== generationRef.current) return;
          const expiry = Date.parse(session.publicSession.expiresAt);
          if (requiresFreshAgentStudioLogin(caught)) {
            resetLocal();
          } else if (!Number.isFinite(expiry) || Date.now() >= expiry) {
            resetLocal();
            const cleanupGeneration = generationRef.current;
            setBusy(true);
            void authLogout()
              .catch((logoutError) => {
                if (cleanupGeneration === generationRef.current) {
                  setError(messageOf(logoutError));
                }
              })
              .finally(() => {
                if (cleanupGeneration === generationRef.current) setBusy(false);
              });
          }
          setError(messageOf(caught));
        });
    };
    const expiryDelay = Math.min(
      MAX_BROWSER_TIMEOUT_MS,
      Math.max(0, Date.parse(session.publicSession.expiresAt) - Date.now())
    );
    const expiryId = window.setTimeout(verify, expiryDelay);
    const verifyId = window.setInterval(verify, 30_000);
    return () => {
      window.clearTimeout(expiryId);
      window.clearInterval(verifyId);
    };
  }, [installSession, resetLocal, session?.contextId, session?.publicSession.expiresAt]);

  const preauthenticate = useCallback(async (username: string, password: string) => {
    resetLocal();
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      await authPreauthenticate(username, password);
      if (generation !== generationRef.current) return;
      const items = await authCompanies();
      if (generation !== generationRef.current) return;
      setCompanies(items);
      setStep("company");
    } catch (caught) {
      if (generation !== generationRef.current) return;
      if (agentStudioErrorCode(caught) === "AUTH_LOGIN_FLOW_INVALID") resetLocal();
      setError(messageOf(caught));
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [resetLocal]);

  const selectCompany = useCallback(async (companyId: string) => {
    const generation = generationRef.current;
    const requestId = ++companyRequestRef.current;
    setBusy(true);
    setError(null);
    setSelectedCompanyId(companyId);
    setBranches([]);
    setStep("company");
    try {
      const items = await authBranches(companyId);
      if (generation !== generationRef.current || requestId !== companyRequestRef.current) return;
      setBranches(items);
      setStep("branch");
    } catch (caught) {
      if (generation !== generationRef.current || requestId !== companyRequestRef.current) return;
      if (agentStudioErrorCode(caught) === "AUTH_LOGIN_FLOW_INVALID") {
        resetLocal();
      } else {
        setSelectedCompanyId("");
      }
      setError(messageOf(caught));
    } finally {
      if (generation === generationRef.current && requestId === companyRequestRef.current) {
        setBusy(false);
      }
    }
  }, [resetLocal]);

  const selectBranch = useCallback(async (branchId: string) => {
    const generation = generationRef.current;
    const companyRequestId = companyRequestRef.current;
    const companyId = selectedCompanyId;
    setBusy(true);
    setError(null);
    try {
      const completed = await authComplete(companyId, branchId);
      if (
        generation !== generationRef.current ||
        companyRequestId !== companyRequestRef.current
      ) return;
      installSession(completed);
    } catch (caught) {
      if (
        generation !== generationRef.current ||
        companyRequestId !== companyRequestRef.current
      ) return;
      resetLocal();
      setError(messageOf(caught));
    } finally {
      if (
        generation === generationRef.current &&
        companyRequestId === companyRequestRef.current
      ) setBusy(false);
    }
  }, [installSession, selectedCompanyId]);

  const logout = useCallback(async () => {
    resetLocal();
    const generation = generationRef.current;
    setBusy(true);
    try {
      await authLogout();
    } catch (caught) {
      if (generation === generationRef.current) setError(messageOf(caught));
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, [resetLocal]);

  return {
    session,
    step,
    companies,
    branches,
    selectedCompanyId,
    sessionRecoveryRequired,
    busy,
    error,
    preauthenticate,
    selectCompany,
    selectBranch,
    retrySession,
    logout
  };
}
