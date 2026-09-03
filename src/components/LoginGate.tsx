import { FormEvent, type PointerEvent, useEffect, useState } from "react";
import type { AuthBranchSummary, AuthCompanySummary } from "../lib/auth-contracts";
import { t } from "../lib/i18n";
import { setPeekMode, startWindowDragForMode } from "../lib/tauri";
import { LOGIN_WINDOW_SIZE } from "../lib/window-presets";
import { AuthCombobox } from "./AuthCombobox";
import orgaSoftIconUrl from "../../src-tauri/icons/icon.png";

interface LoginGateProps {
  step: "credentials" | "company" | "branch";
  companies: AuthCompanySummary[];
  branches: AuthBranchSummary[];
  selectedCompanyId: string;
  busy: boolean;
  error: string | null;
  sessionRecoveryRequired: boolean;
  onCredentials: (username: string, password: string) => Promise<void>;
  onCompany: (companyId: string) => Promise<void>;
  onBranch: (branchId: string) => Promise<void>;
  onRetrySession: () => Promise<void>;
  onLogout: () => Promise<void>;
}

export function LoginGate(props: LoginGateProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedBranchId, setSelectedBranchId] = useState("");

  const view = props.sessionRecoveryRequired
    ? "recovery"
    : props.step === "credentials"
      ? "credentials"
      : "tenant";

  useEffect(() => {
    void setPeekMode(
      "expanded",
      LOGIN_WINDOW_SIZE.width,
      LOGIN_WINDOW_SIZE.height,
      undefined,
      undefined,
      false,
      true
    ).catch((error) => {
      console.error("Failed to size the DesktopAvatar login window.", error);
    });
  }, []);

  useEffect(() => {
    if (props.step !== "branch") {
      setSelectedBranchId("");
      return;
    }
    setSelectedBranchId((current) =>
      props.branches.some((branch) => branch.branchId === current)
        ? current
        : (props.branches[0]?.branchId ?? "")
    );
  }, [props.branches, props.step]);

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    const submittedPassword = password;
    setPassword("");
    void props.onCredentials(username.trim(), submittedPassword);
  };

  const submitTenant = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedBranchId) return;
    void props.onBranch(selectedBranchId);
  };

  const startLoginWindowDrag = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, button, a, select, textarea, label")) return;
    void startWindowDragForMode("expanded").catch((error) => {
      console.error("Failed to start dragging the SYNTRA login window.", error);
    });
  };

  return (
    <main className="auth-gate" aria-busy={props.busy} onPointerDown={startLoginWindowDrag}>
      <div className="auth-gate__orb" aria-hidden="true">
        <img className="auth-gate__orb-logo" src={orgaSoftIconUrl} alt="" />
        <span className="auth-gate__orb-ring" />
      </div>
      <div className="auth-login-overlay">
        <section className="auth-card" aria-labelledby="auth-title">
          <header className="auth-card__header">
            <p className="auth-card__eyebrow">SYNTRA · Desktop Agent</p>
            <h1 id="auth-title">{t("auth.title")}</h1>
            <p className="auth-card__intro">{t("auth.intro")}</p>
          </header>

          <div className="auth-card__body">
            <div key={view} className={`auth-step auth-step--${view}`}>
              {view === "recovery" ? (
              <div className="auth-options">
                <button type="button" disabled={props.busy} onClick={() => void props.onRetrySession()}>
                  {t("auth.retry")}
                </button>
                <button type="button" disabled={props.busy} onClick={() => void props.onLogout()}>
                  {t("auth.logout")}
                </button>
              </div>
            ) : view === "credentials" ? (
              <form className="auth-form" onSubmit={submitCredentials}>
                <label>
                  {t("auth.username")}
                  <input
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    disabled={props.busy}
                    required
                  />
                </label>
                <label>
                  {t("auth.password")}
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    disabled={props.busy}
                    required
                  />
                </label>
                <button type="submit" disabled={props.busy || !username.trim() || !password}>
                  {props.busy ? t("auth.working") : t("auth.continue")}
                </button>
              </form>
            ) : (
              <form className="auth-form auth-tenant-form" onSubmit={submitTenant}>
                <AuthCombobox
                    label={t("auth.company")}
                  placeholder={t("auth.companyPlaceholder")}
                  emptyMessage={t("auth.noResults")}
                  openLabel={t("auth.openOptions")}
                  closeLabel={t("auth.closeOptions")}
                    options={props.companies.map((company) => ({
                      value: company.companyId,
                      label: company.companyName
                    }))}
                    value={props.selectedCompanyId}
                    disabled={props.busy}
                    onChange={(companyId) => {
                      setSelectedBranchId("");
                      void props.onCompany(companyId);
                    }}
                />
                <AuthCombobox
                    label={t("auth.branch")}
                  placeholder={t("auth.branchPlaceholder")}
                  emptyMessage={t("auth.noResults")}
                  openLabel={t("auth.openOptions")}
                  closeLabel={t("auth.closeOptions")}
                    options={props.branches.map((branch) => ({
                      value: branch.branchId,
                      label: branch.branchName
                    }))}
                    value={selectedBranchId}
                    disabled={props.busy || props.step !== "branch" || props.branches.length === 0}
                    onChange={setSelectedBranchId}
                />
                <button type="submit" disabled={props.busy || !selectedBranchId}>
                  {props.busy ? t("auth.working") : t("auth.login")}
                </button>
              </form>
              )}
            </div>
          </div>

          <p className="auth-card__status" role="status" aria-live="polite">
            {props.error ?? (props.busy ? t("auth.working") : "")}
          </p>
        </section>
      </div>
    </main>
  );
}
