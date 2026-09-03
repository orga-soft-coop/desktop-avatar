import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  setPeekMode: vi.fn().mockResolvedValue(undefined),
  startWindowDragForMode: vi.fn().mockResolvedValue(undefined)
}));

const auth = vi.hoisted(() => ({
  session: null,
  step: "credentials" as const,
  companies: [],
  branches: [],
  selectedCompanyId: "",
  busy: false,
  error: null,
  sessionRecoveryRequired: false,
  preauthenticate: vi.fn().mockResolvedValue(undefined),
  selectCompany: vi.fn().mockResolvedValue(undefined),
  selectBranch: vi.fn().mockResolvedValue(undefined),
  retrySession: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../hooks/useTenantSession", () => ({
  useTenantSession: () => auth
}));

vi.mock("../components/AvatarStage", () => ({
  AvatarStage: () => <div data-testid="avatar-stage" />
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  setPeekMode: windowApi.setPeekMode,
  startWindowDragForMode: windowApi.startWindowDragForMode
}));

import App from "../App";

describe("App unauthenticated startup", () => {
  afterEach(() => {
    cleanup();
    windowApi.setPeekMode.mockClear();
    windowApi.startWindowDragForMode.mockClear();
  });

  it("opens the login-sized neutral entrance without mounting the avatar stage", async () => {
    const { container } = render(<App />);

    expect(container.querySelector(".auth-gate__orb")).toBeInTheDocument();
    expect(container.querySelector(".auth-gate__orb-logo")).toBeInTheDocument();
    expect(container.querySelector(".auth-login-overlay > .auth-card")).toBeInTheDocument();
    expect(container.querySelector(".data-panel-slider")).not.toBeInTheDocument();
    expect(screen.getByText("SYNTRA · Desktop Agent")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bei SYNTRA anmelden" })).toBeInTheDocument();
    expect(screen.queryByTestId("avatar-stage")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(windowApi.setPeekMode).toHaveBeenCalledWith(
        "expanded",
        520,
        600,
        undefined,
        undefined,
        false,
        true
      )
    );

    screen.getByText("SYNTRA · Desktop Agent").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    await waitFor(() =>
      expect(windowApi.startWindowDragForMode).toHaveBeenCalledWith("expanded")
    );

    screen.getByLabelText("Benutzername").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    expect(windowApi.startWindowDragForMode).toHaveBeenCalledOnce();
  });
});
