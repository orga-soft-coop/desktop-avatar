import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginGate } from "../components/LoginGate";

describe("LoginGate", () => {
  afterEach(cleanup);

  it("submits credentials only through the Agent Studio login callback", async () => {
    const user = userEvent.setup();
    const onCredentials = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginGate
        step="credentials"
        companies={[]}
        branches={[]}
        selectedCompanyId=""
        busy={false}
        error={null}
        sessionRecoveryRequired={false}
        onCredentials={onCredentials}
        onCompany={vi.fn()}
        onBranch={vi.fn()}
        onRetrySession={vi.fn()}
        onLogout={vi.fn()}
      />
    );

    const neutralOrb = document.querySelector(".auth-gate__orb");
    expect(neutralOrb).toHaveAttribute("aria-hidden", "true");
    expect(document.querySelector(".auth-gate__orb-logo")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Benutzername"), "alice");
    await user.type(screen.getByLabelText("Passwort"), "secret");
    await user.click(screen.getByRole("button", { name: "Weiter" }));

    expect(onCredentials).toHaveBeenCalledWith("alice", "secret");
    expect(screen.getByLabelText("Passwort")).toHaveValue("");
  });

  it("selects company and branch through the combined tenant dropdown step", async () => {
    const user = userEvent.setup();
    const onCompany = vi.fn().mockResolvedValue(undefined);
    const onBranch = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <LoginGate
        step="company"
        companies={[
          { companyId: "same-id", companyName: "Company A" },
          { companyId: "other-id", companyName: "Company B" }
        ]}
        branches={[]}
        selectedCompanyId=""
        busy={false}
        error={null}
        sessionRecoveryRequired={false}
        onCredentials={vi.fn()}
        onCompany={onCompany}
        onBranch={onBranch}
        onRetrySession={vi.fn()}
        onLogout={vi.fn()}
      />
    );
    const companyCombobox = screen.getByRole("combobox", { name: "Firma" });
    await user.click(companyCombobox);
    await user.type(companyCombobox, "Company A");
    expect(screen.getByRole("option", { name: /Company A/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Company B/ })).toBeNull();
    await user.keyboard("{Enter}");
    expect(onCompany).toHaveBeenCalledWith("same-id");

    rerender(
      <LoginGate
        step="branch"
        companies={[{ companyId: "same-id", companyName: "Company A" }]}
        branches={[{ companyId: "same-id", branchId: "same-id", branchName: "Branch A" }]}
        selectedCompanyId="same-id"
        busy={false}
        error={null}
        sessionRecoveryRequired={false}
        onCredentials={vi.fn()}
        onCompany={onCompany}
        onBranch={onBranch}
        onRetrySession={vi.fn()}
        onLogout={vi.fn()}
      />
    );
    expect(screen.getByRole("combobox", { name: "Firma" })).toHaveValue("Company A");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Niederlassung" })).toHaveValue("Branch A")
    );
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(onBranch).toHaveBeenCalledWith("same-id");
  });

  it("keeps transient session recovery separate from a new login", async () => {
    const user = userEvent.setup();
    const onRetrySession = vi.fn().mockResolvedValue(undefined);
    const onLogout = vi.fn().mockResolvedValue(undefined);
    const recoveryView = render(
      <LoginGate
        step="credentials"
        companies={[]}
        branches={[]}
        selectedCompanyId=""
        busy={false}
        error="Agent Studio ist momentan nicht erreichbar."
        sessionRecoveryRequired
        onCredentials={vi.fn()}
        onCompany={vi.fn()}
        onBranch={vi.fn()}
        onRetrySession={onRetrySession}
        onLogout={onLogout}
      />
    );

    expect(recoveryView.container.querySelector("input")).toBeNull();
    const recovery = within(recoveryView.container);
    await user.click(recovery.getByRole("button", { name: "Sitzung erneut prüfen" }));
    expect(onRetrySession).toHaveBeenCalledOnce();
    await user.click(recovery.getByRole("button", { name: "Abmelden" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
