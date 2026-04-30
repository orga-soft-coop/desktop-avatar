import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  TtsStateEvent
} from "../lib/contracts";

const mocks = vi.hoisted(() => {
  let streamHandlers: {
    onEvent: ((event: DesktopAvatarStreamEvent) => void) | null;
    onDisconnect: ((event: DesktopAvatarStreamLifecycleEvent) => void) | null;
    onTtsState: ((event: TtsStateEvent) => void) | null;
    onTrayPeekOpen: (() => void) | null;
    onTrayPeekCollapse: (() => void) | null;
    onTrayPeekPositionChanged: ((position: "top-left" | "top-right" | "bottom-left" | "bottom-right") => void) | null;
  } = {
    onEvent: null,
    onDisconnect: null,
    onTtsState: null,
    onTrayPeekOpen: null,
    onTrayPeekCollapse: null,
    onTrayPeekPositionChanged: null
  };

  return {
    streamHandlers,
    getBootstrapStateMock: vi.fn(),
    listTtsVoicesMock: vi.fn(),
    onStreamEventMock: vi.fn(),
    onTrayPeekCollapseMock: vi.fn(async (handler: () => void) => {
      streamHandlers.onTrayPeekCollapse = handler;
      return () => {
        streamHandlers.onTrayPeekCollapse = null;
      };
    }),
    onTrayPeekOpenMock: vi.fn(async (handler: () => void) => {
      streamHandlers.onTrayPeekOpen = handler;
      return () => {
        streamHandlers.onTrayPeekOpen = null;
      };
    }),
    onTrayPeekPositionChangedMock: vi.fn(
      async (
        handler: (position: "top-left" | "top-right" | "bottom-left" | "bottom-right") => void
      ) => {
        streamHandlers.onTrayPeekPositionChanged = handler;
        return () => {
          streamHandlers.onTrayPeekPositionChanged = null;
        };
      }
    ),
    onTtsStateMock: vi.fn(async (handler: (event: TtsStateEvent) => void) => {
      streamHandlers.onTtsState = handler;
      return () => {
        streamHandlers.onTtsState = null;
      };
    }),
    resizeWindowMock: vi.fn(),
    sendLocalChatMock: vi.fn(),
    setPeekModeMock: vi.fn(),
    setPeekPositionMock: vi.fn(),
    speakTextMock: vi.fn(),
    startWindowDragMock: vi.fn(),
    stopSpeakingMock: vi.fn(),
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
  listTtsVoices: mocks.listTtsVoicesMock,
  onStreamEvent: mocks.onStreamEventMock,
  onTrayPeekCollapse: mocks.onTrayPeekCollapseMock,
  onTrayPeekOpen: mocks.onTrayPeekOpenMock,
  onTrayPeekPositionChanged: mocks.onTrayPeekPositionChangedMock,
  onTtsState: mocks.onTtsStateMock,
  resizeWindow: mocks.resizeWindowMock,
  sendLocalChat: mocks.sendLocalChatMock,
  setPeekMode: mocks.setPeekModeMock,
  setPeekPosition: mocks.setPeekPositionMock,
  speakText: mocks.speakTextMock,
  startWindowDrag: mocks.startWindowDragMock,
  startWindowDragForMode: mocks.startWindowDragMock,
  stopSpeaking: mocks.stopSpeakingMock,
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
    window.localStorage.clear();
    mocks.streamHandlers.onEvent = null;
    mocks.streamHandlers.onDisconnect = null;
    mocks.streamHandlers.onTtsState = null;
    mocks.streamHandlers.onTrayPeekOpen = null;
    mocks.streamHandlers.onTrayPeekCollapse = null;
    mocks.streamHandlers.onTrayPeekPositionChanged = null;
    mocks.getBootstrapStateMock.mockReset().mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: false
    });
    mocks.listTtsVoicesMock.mockReset().mockResolvedValue([]);
    mocks.onStreamEventMock.mockReset().mockResolvedValue(() => {});
    mocks.onTrayPeekCollapseMock.mockReset().mockImplementation(async (handler: () => void) => {
      mocks.streamHandlers.onTrayPeekCollapse = handler;
      return () => {
        mocks.streamHandlers.onTrayPeekCollapse = null;
      };
    });
    mocks.onTrayPeekOpenMock.mockReset().mockImplementation(async (handler: () => void) => {
      mocks.streamHandlers.onTrayPeekOpen = handler;
      return () => {
        mocks.streamHandlers.onTrayPeekOpen = null;
      };
    });
    mocks.onTrayPeekPositionChangedMock
      .mockReset()
      .mockImplementation(
        async (
          handler: (
            position: "top-left" | "top-right" | "bottom-left" | "bottom-right"
          ) => void
        ) => {
          mocks.streamHandlers.onTrayPeekPositionChanged = handler;
          return () => {
            mocks.streamHandlers.onTrayPeekPositionChanged = null;
          };
        }
      );
    mocks.onTtsStateMock.mockClear();
    mocks.resizeWindowMock.mockReset().mockResolvedValue(undefined);
    mocks.sendLocalChatMock.mockReset().mockResolvedValue(undefined);
    mocks.setPeekModeMock.mockReset().mockResolvedValue(undefined);
    mocks.setPeekPositionMock.mockReset().mockResolvedValue(undefined);
    mocks.speakTextMock.mockReset().mockResolvedValue(undefined);
    mocks.startWindowDragMock.mockReset();
    mocks.stopSpeakingMock.mockReset().mockResolvedValue(undefined);
    mocks.transcribeAudioMock.mockReset();
    mocks.createRequestMock.mockReset();
    mocks.getRequestMock.mockReset();
    mocks.connectStreamMock.mockClear();
  });

  it("uses selected voice and persists TTS off across remounts", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true
    });
    mocks.listTtsVoicesMock.mockResolvedValue(["onyx", "echo"]);
    mocks.createRequestMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-voice",
      status: "RECEIVED",
      streamUrl: "/stream/req-voice",
      pollUrl: "/poll/req-voice",
      idempotent: false
    });

    const first = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());
    expect(first.result.current.ttsEnabled).toBe(true);

    act(() => {
      first.result.current.selectTtsVoice("echo");
      first.result.current.setDraft("Zeig mir die letzten 10 Bestellungen.");
    });
    await act(async () => {
      await first.result.current.submitCurrentDraft();
    });

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "talk",
        avatarRequestId: "req-voice",
        talk: { text: "Antwort eins." },
        emittedAt: "2026-04-21T10:00:00.000Z"
      });
    });
    await waitFor(() =>
      expect(mocks.speakTextMock).toHaveBeenCalledWith("req-voice", "Antwort eins.", "echo")
    );

    await act(async () => {
      await first.result.current.toggleTts();
    });
    expect(first.result.current.ttsEnabled).toBe(false);

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "talk",
        avatarRequestId: "req-voice",
        talk: { text: "Antwort zwei." },
        emittedAt: "2026-04-21T10:00:01.000Z"
      });
    });
    await waitFor(() => expect(mocks.speakTextMock).toHaveBeenCalledTimes(1));

    first.unmount();
    const second = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(second.result.current.ttsEnabled).toBe(false));
  });

  it("keeps TTS disabled when bootstrap config disables it even with a stored opt-in", async () => {
    window.localStorage.setItem("desktop-avatar.ttsEnabled", "true");

    const { result } = renderHook(() => useDesktopCompanion());

    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.ttsEnabled).toBe(false));
    expect(window.localStorage.getItem("desktop-avatar.ttsEnabled")).toBe("false");
  });

  it("starts in expanded peek mode by default", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    expect(result.current.peekMode).toBe("expanded");
    expect(mocks.setPeekModeMock).toHaveBeenCalledWith(
      "expanded",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false
    );
  });

  it("reacts to tray peek collapse/open and position events", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onTrayPeekCollapse?.();
    });
    await waitFor(() => expect(result.current.peekMode).toBe("peek"));

    act(() => {
      mocks.streamHandlers.onTrayPeekPositionChanged?.("bottom-left");
    });
    await waitFor(() => expect(result.current.peekPosition).toBe("bottom-left"));
    expect(window.localStorage.getItem("desktop-avatar.peekPosition")).toBe("bottom-left");

    act(() => {
      mocks.streamHandlers.onTrayPeekOpen?.();
    });
    await waitFor(() => expect(result.current.peekMode).toBe("expanded"));
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
    expect(result.current.status).toContain("Warte");

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
      expect(result.current.latencyDebug?.requestKind).toBe("desktop-avatar");
      expect(result.current.latencyDebug?.firstResponseMs).not.toBeNull();
      expect(result.current.latencyDebug?.completedMs).not.toBeNull();
      expect(result.current.latencyDebug?.usedPolling).toBe(false);
    });
  });

  it("uses API-first routing for non-casual prompts", async () => {
    mocks.createRequestMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-api-first",
      status: "RECEIVED",
      streamUrl: "/stream/req-api-first",
      pollUrl: "/poll/req-api-first",
      idempotent: false
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Welche Artikel muss ich nachbestellen?");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    expect(mocks.createRequestMock).toHaveBeenCalledTimes(1);
    expect(mocks.sendLocalChatMock).not.toHaveBeenCalled();
  });

  it("tracks actual TTS provider and fallback usage in latency debug", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true
    });
    mocks.createRequestMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-tts-provider",
      status: "RECEIVED",
      streamUrl: "/stream/req-tts-provider",
      pollUrl: "/poll/req-tts-provider",
      idempotent: false
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Bitte zeig mir die letzten Bestellungen.");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "talk",
        avatarRequestId: "req-tts-provider",
        talk: { text: "Hier ist die Zusammenfassung." },
        emittedAt: "2026-04-21T10:00:00.000Z"
      });
    });

    await waitFor(() => {
      expect(mocks.speakTextMock).toHaveBeenCalledWith(
        "req-tts-provider",
        "Hier ist die Zusammenfassung.",
        null
      );
      expect(typeof mocks.streamHandlers.onTtsState).toBe("function");
    });

    act(() => {
      mocks.streamHandlers.onTtsState?.({
        requestId: "req-tts-provider",
        speaking: true,
        provider: "system",
        fallback: true
      });
      mocks.streamHandlers.onTtsState?.({
        requestId: "req-tts-provider",
        speaking: false,
        provider: "system",
        fallback: true
      });
    });

    await waitFor(() => {
      expect(result.current.latencyDebug?.ttsProvider).toBe("system");
      expect(result.current.latencyDebug?.ttsFallbackUsed).toBe(true);
      expect(result.current.latencyDebug?.ttsStartedMs).not.toBeNull();
      expect(result.current.latencyDebug?.ttsSpeakDurationMs).not.toBeNull();
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
      result.current.setDraft("Welche Bestellungen sind offen?");
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
      expect(result.current.latencyDebug?.usedPolling).toBe(true);
      expect(result.current.latencyDebug?.pollFallbackMs).not.toBeNull();
      expect(result.current.latencyDebug?.firstResponseMs).not.toBeNull();
    });
  });

  it("falls back to local chat on unsupported/no-match backend errors", async () => {
    mocks.createRequestMock.mockRejectedValueOnce(
      "Desktop Avatar create returned 409 Conflict: No active studio agents support READ_SQL_SERVER_QUERY."
    );

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Zeig mir die letzten 10 Bestellungen von gestern");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    await waitFor(() => {
      expect(mocks.sendLocalChatMock).toHaveBeenCalledTimes(1);
      expect(result.current.error).toBeNull();
      expect(result.current.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    });
  });

  it("does not fall back to local chat on technical backend errors", async () => {
    mocks.createRequestMock.mockRejectedValueOnce(new Error("network timeout"));

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Zeig mir die letzten 10 Bestellungen von gestern");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    await waitFor(() => {
      expect(mocks.sendLocalChatMock).not.toHaveBeenCalled();
      expect(result.current.error).toContain("network timeout");
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
