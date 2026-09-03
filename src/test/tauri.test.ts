import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: invokeMock
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock
}));

import {
  createDesktopAvatarRequest,
  onTenantSessionInvalidated,
  onHitlDecisionStreamEvent,
  onDesktopAvatarStreamEvent,
  onTranscriptionSessionEvent,
  onTtsState,
  requestMoreInfoForHitl,
  transcribeAudio
} from "../lib/tauri";
import { activateTenantSession, clearTenantSession } from "../lib/tenant-session";

function installTenantSession(contextId = "context-1"): void {
  const tenant = {
    tenantId: `tenant-${contextId}`,
    companyId: "701",
    companyName: "Company",
    branchId: "1",
    branchName: "Branch",
    canAdminister: true
  };
  activateTenantSession({
    contextId,
    localEpoch: 1,
    publicSession: {
      sessionId: "session-1",
      user: { id: "user-1", username: "user", globalAuthorities: [] },
      selectedTenant: tenant,
      accessibleTenants: [tenant],
      administrableTenantIds: [tenant.tenantId],
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  });
}

describe("tauri runtime guards", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    clearTenantSession();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("returns a noop unlisten callback for desktop avatar events when tauri is unavailable", async () => {
    const unlisten = await onDesktopAvatarStreamEvent(() => {});

    expect(typeof unlisten).toBe("function");
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("returns a noop unlisten callback for HITL events when tauri is unavailable", async () => {
    const unlisten = await onHitlDecisionStreamEvent(() => {});

    expect(typeof unlisten).toBe("function");
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("rejects voice transcription with a descriptive browser fallback error", async () => {
    await expect(
      transcribeAudio({
        audioBase64: "SGVsbG8=",
        mimeType: "audio/webm"
      })
    ).rejects.toThrow("Sprachtranskription benötigt die Tauri-Desktop-Shell.");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects desktop avatar create requests with a descriptive browser fallback error", async () => {
    await expect(
      createDesktopAvatarRequest({
        clientRequestId: "client-1",
        utterance: "Hello",
        responseModes: ["talk", "widget"]
      })
    ).rejects.toThrow("SYNTRA Assistant Anfrage benötigt die Tauri-Desktop-Shell.");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("sends HITL request-more-info through the Tauri command bridge", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);
    installTenantSession();

    await requestMoreInfoForHitl({
      runId: "run:1",
      message: "Bitte Lieferantwerk pruefen"
    });

    expect(invokeMock).toHaveBeenCalledWith("hitl_request_more_info", {
      input: {
        runId: "run:1",
        message: "Bitte Lieferantwerk pruefen"
      },
      expectedContextId: "context-1"
    });
  });

  it("drops stale tenant events even when the request id is identical", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    installTenantSession();
    let eventHandler: ((event: { payload: unknown }) => void) | undefined;
    listenMock.mockImplementation(async (_name, handler) => {
      eventHandler = handler;
      return () => {};
    });
    const listener = vi.fn();

    await onDesktopAvatarStreamEvent(listener);
    eventHandler?.({
      payload: { contextId: "old-context", avatarRequestId: "same-request", type: "status" }
    });
    eventHandler?.({
      payload: { contextId: "context-1", avatarRequestId: "same-request", type: "status" }
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "context-1", avatarRequestId: "same-request" })
    );
  });

  it("drops stale transcription and TTS events with identical business ids", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    installTenantSession();
    const handlers = new Map<string, (event: { payload: never }) => void>();
    listenMock.mockImplementation(async (name, handler) => {
      handlers.set(name, handler);
      return () => {};
    });
    const transcriptionListener = vi.fn();
    const ttsListener = vi.fn();
    await onTranscriptionSessionEvent(transcriptionListener);
    await onTtsState(ttsListener);

    handlers.get("transcription-stream-event")?.({
      payload: { contextId: "old-context", sessionId: "same-id", type: "final", text: "A" }
    } as never);
    handlers.get("tts-state")?.({
      payload: { contextId: "old-context", requestId: "same-id", speaking: true }
    } as never);
    handlers.get("transcription-stream-event")?.({
      payload: { contextId: "context-1", sessionId: "same-id", type: "final", text: "B" }
    } as never);
    handlers.get("tts-state")?.({
      payload: { contextId: "context-1", requestId: "same-id", speaking: true }
    } as never);

    expect(transcriptionListener).toHaveBeenCalledTimes(1);
    expect(ttsListener).toHaveBeenCalledTimes(1);
  });

  it("invalidates the local context immediately on a bodyless business session 401", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    installTenantSession();
    const unauthorized = { status: 401, code: null, message: "Unauthorized" };
    invokeMock.mockRejectedValueOnce(unauthorized).mockRejectedValue(undefined);
    const invalidated = vi.fn();
    const unlisten = onTenantSessionInvalidated(invalidated);

    await expect(
      createDesktopAvatarRequest({ clientRequestId: "same-id", utterance: "A" })
    ).rejects.toBe(unauthorized);

    expect(invalidated).toHaveBeenCalledTimes(1);
    await expect(
      createDesktopAvatarRequest({ clientRequestId: "same-id", utterance: "B" })
    ).rejects.toThrow("DESKTOP_SESSION_CHANGED");
    unlisten();
  });

  it("requires an active immutable tenant context for every business mutation", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);

    await expect(
      requestMoreInfoForHitl({ runId: "same-run", message: "continue" })
    ).rejects.toThrow("DESKTOP_SESSION_CHANGED");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects an explicitly captured context after a replacement login", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue(undefined);
    installTenantSession("context-a");
    installTenantSession("context-b");

    await expect(
      createDesktopAvatarRequest(
        { clientRequestId: "same-id", utterance: "tenant-a input" },
        "context-a",
      ),
    ).rejects.toThrow("DESKTOP_SESSION_CHANGED");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
