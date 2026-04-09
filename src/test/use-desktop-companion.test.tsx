import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent
} from "../lib/contracts";

const mocks = vi.hoisted(() => {
  let streamHandlers: {
    onEvent: ((event: DesktopAvatarStreamEvent) => void) | null;
    onDisconnect: ((event: DesktopAvatarStreamLifecycleEvent) => void) | null;
  } = { onEvent: null, onDisconnect: null };

  return {
    streamHandlers,
    getBootstrapStateMock: vi.fn(),
    onStreamEventMock: vi.fn(),
    onTtsStateMock: vi.fn(),
    resizeWindowMock: vi.fn(),
    sendLocalChatMock: vi.fn(),
    setClickThroughMock: vi.fn(),
    speakTextMock: vi.fn(),
    startWindowDragMock: vi.fn(),
    stopSpeakingMock: vi.fn(),
    toggleExpandedWindowMock: vi.fn(),
    transcribeAudioMock: vi.fn(),
    createRequestMock: vi.fn(),
    getRequestMock: vi.fn(),
    connectStreamMock: vi.fn(async (args: {
      avatarRequestId: string;
      streamUrl?: string;
      onEvent: (event: DesktopAvatarStreamEvent) => void;
      onDisconnect: (event: DesktopAvatarStreamLifecycleEvent) => void;
    }) => {
      streamHandlers.onEvent = args.onEvent;
      streamHandlers.onDisconnect = args.onDisconnect;
      return {
        close: vi.fn(async () => {
          streamHandlers.onEvent = null;
          streamHandlers.onDisconnect = null;
        })
      };
    })
  };
});

vi.mock("../lib/desktop-avatar-api", () => ({
  desktopAvatarApiClient: {
    createRequest: mocks.createRequestMock,
    getRequest: mocks.getRequestMock,
    connectStream: mocks.connectStreamMock
  }
}));

vi.mock("../lib/tauri", () => ({
  getBootstrapState: mocks.getBootstrapStateMock,
  onStreamEvent: mocks.onStreamEventMock,
  onTtsState: mocks.onTtsStateMock,
  resizeWindow: mocks.resizeWindowMock,
  sendLocalChat: mocks.sendLocalChatMock,
  setClickThrough: mocks.setClickThroughMock,
  speakText: mocks.speakTextMock,
  startWindowDrag: mocks.startWindowDragMock,
  stopSpeaking: mocks.stopSpeakingMock,
  toggleExpandedWindow: mocks.toggleExpandedWindowMock,
  transcribeAudio: mocks.transcribeAudioMock
}));

import { useDesktopCompanion } from "../hooks/useDesktopCompanion";

function latestAssistantText(messages: ReturnType<typeof useDesktopCompanion>["messages"]) {
  return [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
}

describe("useDesktopCompanion desktop avatar integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    mocks.streamHandlers.onEvent = null;
    mocks.streamHandlers.onDisconnect = null;
    mocks.getBootstrapStateMock.mockReset().mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: false
    });
    mocks.onStreamEventMock.mockReset().mockResolvedValue(() => {});
    mocks.onTtsStateMock.mockReset().mockResolvedValue(() => {});
    mocks.resizeWindowMock.mockReset().mockResolvedValue(undefined);
    mocks.sendLocalChatMock.mockReset().mockResolvedValue(undefined);
    mocks.setClickThroughMock.mockReset().mockResolvedValue(undefined);
    mocks.speakTextMock.mockReset().mockResolvedValue(undefined);
    mocks.startWindowDragMock.mockReset();
    mocks.stopSpeakingMock.mockReset().mockResolvedValue(undefined);
    mocks.toggleExpandedWindowMock.mockReset().mockResolvedValue(undefined);
    mocks.transcribeAudioMock.mockReset();
    mocks.createRequestMock.mockReset();
    mocks.getRequestMock.mockReset();
    mocks.connectStreamMock.mockClear();
  });

  it("runs the happy path from submit to talk, widget and completion", async () => {
    const createResult: CreateDesktopAvatarRequestResult = {
      accepted: true,
      avatarRequestId: "req-happy",
      status: "RECEIVED",
      streamUrl: "/stream/req-happy",
      pollUrl: "/poll/req-happy",
      idempotent: false
    };
    mocks.createRequestMock.mockResolvedValue(createResult);

    const { result } = renderHook(() => useDesktopCompanion());

    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Welche Bestellungen sind gestern Nacht eingegangen?");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    expect(mocks.createRequestMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toContain("Waiting");

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "status",
        avatarRequestId: "req-happy",
        status: "THINKING",
        message: "Analyse laeuft",
        emittedAt: "2026-04-09T12:00:00.000Z"
      });
    });
    expect(result.current.companionState).toBe("thinking");

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "talk",
        avatarRequestId: "req-happy",
        talk: { text: "Ich habe zwei Bestellungen gefunden." },
        emittedAt: "2026-04-09T12:00:01.000Z"
      });
    });
    expect(latestAssistantText(result.current.messages)).toContain("zwei Bestellungen");
    expect(result.current.companionState).toBe("speaking");

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "widget",
        avatarRequestId: "req-happy",
        widget: {
          type: "table",
          title: "Bestellungen",
          columns: [{ key: "id", label: "ID" }],
          rows: [{ id: "B-2026-00421" }]
        },
        emittedAt: "2026-04-09T12:00:02.000Z"
      });
      mocks.streamHandlers.onEvent?.({
        type: "done",
        avatarRequestId: "req-happy",
        status: "COMPLETED",
        emittedAt: "2026-04-09T12:00:03.000Z"
      });
    });

    await waitFor(() => {
      const latestMessage = result.current.messages[result.current.messages.length - 1];
      expect(latestMessage.widget?.type).toBe("table");
      expect(latestMessage.isStreaming).toBe(false);
      expect(result.current.companionState).toBe("idle");
    });
  });

  it("falls back to polling when the desktop avatar stream disconnects", async () => {
    const createResult: CreateDesktopAvatarRequestResult = {
      accepted: true,
      avatarRequestId: "req-fallback",
      status: "RECEIVED",
      streamUrl: "/stream/req-fallback",
      pollUrl: "/poll/req-fallback",
      idempotent: false
    };
    const pollResult: DesktopAvatarRequestDocument = {
      avatarRequestId: "req-fallback",
      clientRequestId: "desktop-avatar-client:retry",
      status: "COMPLETED",
      response: {
        talk: { text: "Polling hat die Antwort geliefert." },
        widget: {
          type: "text",
          title: "Antwort",
          text: "Abgeschlossen"
        },
        followUpQuestions: []
      },
      error: null
    };
    mocks.createRequestMock.mockResolvedValue(createResult);
    mocks.getRequestMock.mockResolvedValue(pollResult);

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Bitte pruefe die offenen Belege.");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    act(() => {
      mocks.streamHandlers.onDisconnect?.({
        avatarRequestId: "req-fallback",
        phase: "error",
        reason: "socket lost"
      });
    });

    await waitFor(() => {
      const latestMessage = result.current.messages[result.current.messages.length - 1];
      expect(latestMessage.text).toContain("Polling hat die Antwort geliefert");
      expect(latestMessage.widget?.type).toBe("text");
      expect(result.current.error).toBeNull();
    });
  });

  it("reuses the same clientRequestId on retry", async () => {
    mocks.createRequestMock
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValueOnce({
        accepted: true,
        avatarRequestId: "req-retry",
        status: "RECEIVED",
        streamUrl: "/stream/req-retry",
        pollUrl: "/poll/req-retry",
        idempotent: true
      });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Welche Bestellungen sind offen?");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });
    await act(async () => {
      await result.current.retryLastPrompt();
    });

    const firstCall = mocks.createRequestMock.mock.calls[0][0] as CreateDesktopAvatarRequestInput;
    const secondCall = mocks.createRequestMock.mock.calls[1][0] as CreateDesktopAvatarRequestInput;
    expect(firstCall.clientRequestId).toBe(secondCall.clientRequestId);
  });
});
