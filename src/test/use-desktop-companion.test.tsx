import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  BootstrapState,
  DesktopAvatarRadarStreamEvent,
  DesktopAvatarRadarStreamLifecycleEvent,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  HitlDecisionStreamEvent,
  HitlDecisionStreamLifecycleEvent,
  TranscriptionProviderChangedEvent,
  TranscriptionSessionEvent,
  TtsStateEvent
} from "../lib/contracts";
import { activateTenantSession, clearTenantSession } from "../lib/tenant-session";

const mocks = vi.hoisted(() => {
  let streamHandlers: {
    onEvent: ((event: DesktopAvatarStreamEvent) => void) | null;
    onDisconnect: ((event: DesktopAvatarStreamLifecycleEvent) => void) | null;
    onHitlEvent: ((event: HitlDecisionStreamEvent) => void) | null;
    onHitlDisconnect: ((event: HitlDecisionStreamLifecycleEvent) => void) | null;
    onRadarEvent: ((event: DesktopAvatarRadarStreamEvent) => void) | null;
    onRadarDisconnect: ((event: DesktopAvatarRadarStreamLifecycleEvent) => void) | null;
    onTtsState: ((event: TtsStateEvent) => void) | null;
    onTranscriptionSessionEvent: ((event: TranscriptionSessionEvent) => void) | null;
    onTranscriptionProviderChanged: ((event: TranscriptionProviderChangedEvent) => void) | null;
    onTrayPeekOpen: (() => void) | null;
    onTrayPeekCollapse: (() => void) | null;
    onTrayPeekPositionChanged: ((position: "top-left" | "top-right" | "bottom-left" | "bottom-right") => void) | null;
  } = {
    onEvent: null,
    onDisconnect: null,
    onHitlEvent: null,
    onHitlDisconnect: null,
    onRadarEvent: null,
    onRadarDisconnect: null,
    onTtsState: null,
    onTranscriptionSessionEvent: null,
    onTranscriptionProviderChanged: null,
    onTrayPeekOpen: null,
    onTrayPeekCollapse: null,
    onTrayPeekPositionChanged: null
  };

  return {
    streamHandlers,
    getBootstrapStateMock: vi.fn(),
    getTranscriptionProviderMock: vi.fn(),
    listTtsVoicesMock: vi.fn(),
    frontendLogMock: vi.fn(),
    onTranscriptionSessionEventMock: vi.fn(
      async (handler: (event: TranscriptionSessionEvent) => void) => {
        streamHandlers.onTranscriptionSessionEvent = handler;
        return () => {
          streamHandlers.onTranscriptionSessionEvent = null;
        };
      }
    ),
    onTranscriptionProviderChangedMock: vi.fn(
      async (handler: (event: TranscriptionProviderChangedEvent) => void) => {
        streamHandlers.onTranscriptionProviderChanged = handler;
        return () => {
          streamHandlers.onTranscriptionProviderChanged = null;
        };
      }
    ),
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
    setTranscriptionProviderMock: vi.fn(),
    startTranscriptionSessionMock: vi.fn(),
    appendTranscriptionAudioMock: vi.fn(),
    commitTranscriptionTurnMock: vi.fn(),
    stopTranscriptionSessionMock: vi.fn(),
    resizeWindowMock: vi.fn(),
    setPeekModeMock: vi.fn(),
    setPeekPositionMock: vi.fn(),
    speakTextMock: vi.fn(),
    startWindowDragMock: vi.fn(),
    stopSpeakingMock: vi.fn(),
    transcribeAudioMock: vi.fn(),
    createRequestMock: vi.fn(),
    replyClarificationMock: vi.fn(),
    getDatasetPageMock: vi.fn(),
    cancelConversationMock: vi.fn(),
    getRequestMock: vi.fn(),
    getRadarMock: vi.fn(),
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
    }),
    connectHitlDecisionStreamMock: vi.fn(async (args: {
      onEvent: (event: HitlDecisionStreamEvent) => void;
      onDisconnect: (event: HitlDecisionStreamLifecycleEvent) => void;
    }) => {
      streamHandlers.onHitlEvent = args.onEvent;
      streamHandlers.onHitlDisconnect = args.onDisconnect;
      return {
        close: vi.fn(async () => {
          streamHandlers.onHitlEvent = null;
          streamHandlers.onHitlDisconnect = null;
        })
      };
    }),
    connectRadarStreamMock: vi.fn(async (args: {
      onEvent: (event: DesktopAvatarRadarStreamEvent) => void;
      onDisconnect: (event: DesktopAvatarRadarStreamLifecycleEvent) => void;
    }) => {
      streamHandlers.onRadarEvent = args.onEvent;
      streamHandlers.onRadarDisconnect = args.onDisconnect;
      return {
        close: vi.fn(async () => {
          streamHandlers.onRadarEvent = null;
          streamHandlers.onRadarDisconnect = null;
        })
      };
    }),
    approveHitlDecisionMock: vi.fn(),
    rejectHitlDecisionMock: vi.fn(),
    requestMoreInfoForHitlMock: vi.fn()
  };
});

vi.mock("../lib/desktop-avatar-api", () => ({
  desktopAvatarApiClient: {
    createRequest: mocks.createRequestMock,
    replyClarification: mocks.replyClarificationMock,
    getDatasetPage: mocks.getDatasetPageMock,
    cancelConversation: mocks.cancelConversationMock,
    getRequest: mocks.getRequestMock,
    getRadar: mocks.getRadarMock,
    connectStream: mocks.connectStreamMock,
    connectHitlDecisionStream: mocks.connectHitlDecisionStreamMock,
    connectRadarStream: mocks.connectRadarStreamMock,
    approveHitlDecision: mocks.approveHitlDecisionMock,
    rejectHitlDecision: mocks.rejectHitlDecisionMock,
    requestMoreInfoForHitl: mocks.requestMoreInfoForHitlMock
  }
}));

vi.mock("../lib/tauri", () => ({
  appendTranscriptionAudio: mocks.appendTranscriptionAudioMock,
  commitTranscriptionTurn: mocks.commitTranscriptionTurnMock,
  frontendLog: mocks.frontendLogMock,
  getBootstrapState: mocks.getBootstrapStateMock,
  getTranscriptionProvider: mocks.getTranscriptionProviderMock,
  listTtsVoices: mocks.listTtsVoicesMock,
  onTranscriptionProviderChanged: mocks.onTranscriptionProviderChangedMock,
  onTranscriptionSessionEvent: mocks.onTranscriptionSessionEventMock,
  onTrayPeekCollapse: mocks.onTrayPeekCollapseMock,
  onTrayPeekOpen: mocks.onTrayPeekOpenMock,
  onTrayPeekPositionChanged: mocks.onTrayPeekPositionChangedMock,
  onTtsState: mocks.onTtsStateMock,
  resizeWindow: mocks.resizeWindowMock,
  setPeekMode: mocks.setPeekModeMock,
  setPeekPosition: mocks.setPeekPositionMock,
  setTranscriptionProvider: mocks.setTranscriptionProviderMock,
  speakText: mocks.speakTextMock,
  startTranscriptionSession: mocks.startTranscriptionSessionMock,
  startWindowDrag: mocks.startWindowDragMock,
  startWindowDragForMode: mocks.startWindowDragMock,
  stopSpeaking: mocks.stopSpeakingMock,
  stopTranscriptionSession: mocks.stopTranscriptionSessionMock,
  transcribeAudio: mocks.transcribeAudioMock
}));

import { useDesktopCompanion } from "../hooks/useDesktopCompanion";

function latestAssistantText(messages: ReturnType<typeof useDesktopCompanion>["messages"]) {
  return [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
}

function requiredHitlEvent(overrides: {
  decisionId?: string;
  runId?: string;
  proposalId?: string;
  title?: string;
} = {}): HitlDecisionStreamEvent {
  const decisionId = overrides.decisionId ?? "proposal::run%3A1::proposal%3A1";
  const runId = overrides.runId ?? "run:1";
  const proposalId = overrides.proposalId ?? "proposal:1";
  const title = overrides.title ?? "PURCHASE ORDER";
  return {
    type: "decision",
    kind: "required",
    decisionId,
    runId,
    proposalId,
    status: "pending",
    item: {
      decisionId,
      runId,
      proposalId,
      actionId: "PURCHASE_ORDER",
      title,
      description: "Supplier order needs approval.",
      agent: {
        agentId: "studio-agent:purchase",
        agentName: "Purchase Agent",
        agentAvatarId: 1
      },
      timestamp: "2026-06-12T12:00:00.000Z",
      mode: "SIMULATION",
      status: "pending",
      priority: "high",
      contextSections: [],
      payload: {}
    },
    emittedAt: "2026-06-12T12:00:00.000Z"
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useDesktopCompanion desktop avatar integration", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearTenantSession();
  });

  beforeEach(() => {
    const tenant = {
      tenantId: "tenant-a",
      companyId: "701",
      companyName: "Company A",
      branchId: "1",
      branchName: "Branch 1",
      canAdminister: true
    };
    activateTenantSession({
      contextId: "context-a",
      localEpoch: 1,
      publicSession: {
        sessionId: "session-a",
        user: { id: "user-a", username: "alice", globalAuthorities: [] },
        selectedTenant: tenant,
        accessibleTenants: [tenant],
        administrableTenantIds: [tenant.tenantId],
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    });
    window.localStorage.clear();
    mocks.streamHandlers.onEvent = null;
    mocks.streamHandlers.onDisconnect = null;
    mocks.streamHandlers.onHitlEvent = null;
    mocks.streamHandlers.onHitlDisconnect = null;
    mocks.streamHandlers.onTtsState = null;
    mocks.streamHandlers.onTranscriptionSessionEvent = null;
    mocks.streamHandlers.onTranscriptionProviderChanged = null;
    mocks.streamHandlers.onTrayPeekOpen = null;
    mocks.streamHandlers.onTrayPeekCollapse = null;
    mocks.streamHandlers.onTrayPeekPositionChanged = null;
    mocks.getBootstrapStateMock.mockReset().mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: false,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    });
    mocks.getTranscriptionProviderMock
      .mockReset()
      .mockResolvedValue("openai-realtime");
    mocks.listTtsVoicesMock.mockReset().mockResolvedValue([]);
    mocks.frontendLogMock.mockReset().mockResolvedValue(undefined);
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
    mocks.onTranscriptionSessionEventMock
      .mockReset()
      .mockImplementation(async (handler: (event: TranscriptionSessionEvent) => void) => {
        mocks.streamHandlers.onTranscriptionSessionEvent = handler;
        return () => {
          mocks.streamHandlers.onTranscriptionSessionEvent = null;
        };
      });
    mocks.onTranscriptionProviderChangedMock
      .mockReset()
      .mockImplementation(
        async (handler: (event: TranscriptionProviderChangedEvent) => void) => {
          mocks.streamHandlers.onTranscriptionProviderChanged = handler;
          return () => {
            mocks.streamHandlers.onTranscriptionProviderChanged = null;
          };
        }
      );
    mocks.setTranscriptionProviderMock.mockReset().mockResolvedValue("openai-realtime");
    mocks.startTranscriptionSessionMock.mockReset().mockResolvedValue({
      sessionId: "session-1",
      provider: "openai-realtime"
    });
    mocks.appendTranscriptionAudioMock.mockReset().mockResolvedValue(undefined);
    mocks.commitTranscriptionTurnMock
      .mockReset()
      .mockResolvedValue("Test-Transkription");
    mocks.stopTranscriptionSessionMock.mockReset().mockResolvedValue(undefined);
    mocks.resizeWindowMock.mockReset().mockResolvedValue(undefined);
    mocks.setPeekModeMock.mockReset().mockResolvedValue(undefined);
    mocks.setPeekPositionMock.mockReset().mockResolvedValue(undefined);
    mocks.speakTextMock.mockReset().mockResolvedValue(undefined);
    mocks.startWindowDragMock.mockReset();
    mocks.stopSpeakingMock.mockReset().mockResolvedValue(undefined);
    mocks.transcribeAudioMock.mockReset();
    mocks.createRequestMock.mockReset();
    mocks.replyClarificationMock.mockReset();
    mocks.getDatasetPageMock.mockReset();
    mocks.cancelConversationMock.mockReset().mockResolvedValue({
      conversationId: "conversation-1",
      status: "CANCELLED"
    });
    mocks.getRequestMock.mockReset();
    mocks.getRadarMock.mockReset().mockResolvedValue({
      generatedAt: "2026-06-14T09:00:00.000Z",
      summary: {
        totalCount: 0,
        criticalCount: 0,
        highCount: 0,
        needsApprovalCount: 0,
        runningCount: 0,
        failedCount: 0
      },
      items: []
    });
    mocks.connectStreamMock.mockClear();
    mocks.connectHitlDecisionStreamMock.mockClear();
    mocks.connectRadarStreamMock.mockClear();
    mocks.approveHitlDecisionMock.mockReset().mockResolvedValue(undefined);
    mocks.rejectHitlDecisionMock.mockReset().mockResolvedValue(undefined);
    mocks.requestMoreInfoForHitlMock.mockReset().mockResolvedValue(undefined);
  });

  it("keeps radar polling passive until the user opens the radar", async () => {
    mocks.getRadarMock.mockResolvedValue({
      generatedAt: "2026-06-14T09:00:00.000Z",
      summary: {
        totalCount: 1,
        criticalCount: 0,
        highCount: 1,
        needsApprovalCount: 1,
        runningCount: 0,
        failedCount: 0,
        topSignalId: "radar:hitl:decision-1"
      },
      items: [
        {
          signalId: "radar:hitl:decision-1",
          kind: "hitlApproval",
          severity: "high",
          status: "needsApproval",
          title: "Freigabe wartet",
          description: "Eine Freigabe wartet.",
          studioAgentId: "studio-agent:warehouse",
          agentName: "Warehouse Agent",
          agentRole: "DOMAIN",
          decisionId: "decision-1",
          updatedAt: "2026-06-14T09:00:00.000Z",
          audience: {
            scope: "team"
          }
        }
      ]
    });

    const { result } = renderHook(() => useDesktopCompanion());

    await waitFor(() => expect(result.current.operatorRadarSignalCount).toBe(1));
    expect(result.current.operatorRadarWidget).toBeNull();

    act(() => {
      result.current.openOperatorRadar();
    });

    await waitFor(() =>
      expect(result.current.operatorRadarWidget?.type).toBe("operatorRadar"),
    );
  });

  it("updates the radar count from stream snapshots without opening the widget", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectRadarStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onRadarEvent?.({
        type: "snapshot",
        eventId: "radar:snapshot:1",
        emittedAt: "2026-06-14T09:00:00.000Z",
        radar: {
          generatedAt: "2026-06-14T09:00:00.000Z",
          summary: {
            totalCount: 1,
            criticalCount: 0,
            highCount: 0,
            needsApprovalCount: 0,
            runningCount: 1,
            failedCount: 0,
            topSignalId: "radar:runtime:warehouse:running"
          },
          items: [
            {
              signalId: "radar:runtime:warehouse:running",
              kind: "runtimeRunning",
              severity: "info",
              status: "running",
              title: "Warehouse Agent prüft Nachbestellbedarf",
              description: "Runtime-Flow läuft.",
              studioAgentId: "studio-agent:warehouse",
              agentName: "Warehouse Agent",
              agentRole: "DOMAIN",
              updatedAt: "2026-06-14T09:00:00.000Z",
              audience: {
                scope: "team"
              }
            }
          ]
        }
      });
    });

    await waitFor(() => expect(result.current.operatorRadarSignalCount).toBe(1));
    expect(result.current.operatorRadarWidget).toBeNull();
  });

  it("filters snoozed radar signals locally from count and widget", async () => {
    mocks.getRadarMock.mockResolvedValue({
      generatedAt: "2026-06-14T09:00:00.000Z",
      summary: {
        totalCount: 1,
        criticalCount: 0,
        highCount: 0,
        needsApprovalCount: 0,
        runningCount: 1,
        failedCount: 0,
        topSignalId: "radar:runtime:warehouse:running"
      },
      items: [
        {
          signalId: "radar:runtime:warehouse:running",
          kind: "runtimeRunning",
          severity: "info",
          status: "running",
          title: "Warehouse Agent prüft Nachbestellbedarf",
          description: "Runtime-Flow läuft.",
          studioAgentId: "studio-agent:warehouse",
          agentName: "Warehouse Agent",
          agentRole: "DOMAIN",
          updatedAt: "2026-06-14T09:00:00.000Z",
          audience: {
            scope: "team"
          }
        }
      ]
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(result.current.operatorRadarSignalCount).toBe(1));

    act(() => {
      result.current.openOperatorRadar();
    });
    await waitFor(() =>
      expect(result.current.operatorRadarWidget?.type).toBe("operatorRadar"),
    );

    act(() => {
      result.current.snoozeOperatorRadarSignal("radar:runtime:warehouse:running");
    });

    expect(result.current.operatorRadarSignalCount).toBe(0);
    expect(
      result.current.operatorRadarWidget?.type === "operatorRadar"
        ? result.current.operatorRadarWidget.items
        : [],
    ).toHaveLength(0);
  });

  it("adds a HITL card and announces a required decision once", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    const event: HitlDecisionStreamEvent = {
      type: "decision",
      kind: "required",
      decisionId: "proposal::run%3A1::proposal%3A1",
      runId: "run:1",
      proposalId: "proposal:1",
      status: "pending",
      item: {
        decisionId: "proposal::run%3A1::proposal%3A1",
        runId: "run:1",
        proposalId: "proposal:1",
        actionId: "PURCHASE_ORDER",
        title: "PURCHASE ORDER",
        description: "Supplier order needs approval.",
        agent: {
          agentId: "studio-agent:purchase",
          agentName: "Purchase Agent",
          agentAvatarId: 1
        },
        timestamp: "2026-06-12T12:00:00.000Z",
        mode: "SIMULATION",
        status: "pending",
        priority: "high",
        contextSections: [],
        payload: {}
      },
      emittedAt: "2026-06-12T12:00:00.000Z"
    };

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(event);
      mocks.streamHandlers.onHitlEvent?.(event);
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));
    expect(result.current.hitlWidgets[0]?.title).toBe("PURCHASE ORDER");
    await waitFor(() => expect(mocks.speakTextMock).toHaveBeenCalledTimes(1));
    expect(mocks.speakTextMock).toHaveBeenCalledWith(
      "hitl:proposal::run%3A1::proposal%3A1",
      "Eine HITL-Freigabe wartet: PURCHASE ORDER.",
      null,
      "context-a",
    );
  });

  it("batches a burst of HITL required announcements into one spoken update", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      for (let index = 1; index <= 5; index += 1) {
        mocks.streamHandlers.onHitlEvent?.(
          requiredHitlEvent({
            decisionId: `proposal::run%3A${index}::proposal%3A${index}`,
            runId: `run:${index}`,
            proposalId: `proposal:${index}`,
            title: `PURCHASE ORDER ${index}`
          }),
        );
      }
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(5));
    await waitFor(() => expect(mocks.speakTextMock).toHaveBeenCalledTimes(1));
    expect(mocks.speakTextMock).toHaveBeenCalledWith(
      expect.stringContaining("hitl:batch:"),
      "5 HITL-Freigaben warten.",
      null,
      "context-a",
    );
  });

  it("does not announce a HITL decision that resolves before the batch timer fires", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    vi.useFakeTimers();
    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
      mocks.streamHandlers.onHitlEvent?.({
        type: "decision",
        kind: "resolved",
        decisionId: "proposal::run%3A1::proposal%3A1",
        runId: "run:1",
        proposalId: "proposal:1",
        status: "approved",
        emittedAt: "2026-06-12T12:00:01.000Z"
      });
      vi.advanceTimersByTime(300);
    });

    expect(result.current.hitlWidgets).toHaveLength(0);
    expect(result.current.status).toBe("HITL-Freigabe aktualisiert.");
    expect(mocks.speakTextMock).not.toHaveBeenCalled();
  });

  it("hydrates pending HITL cards from the initial stream snapshot", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    const event = requiredHitlEvent();
    if (event.type !== "decision" || !event.item) {
      throw new Error("Test event must include a HITL item.");
    }
    const item = event.item;

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "snapshot",
        items: [item],
        emittedAt: "2026-06-12T12:00:00.000Z"
      });
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));
    expect(result.current.hitlWidgets[0]?.decisionId).toBe(
      "proposal::run%3A1::proposal%3A1"
    );
  });

  it("reconnects the HITL stream so backend snapshots can replay pending work", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalledTimes(1));

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "ready",
        emittedAt: "2026-06-12T12:00:00.000Z"
      });
    });
    expect(result.current.backendConnectionState).toBe("connected");

    vi.useFakeTimers();
    act(() => {
      mocks.streamHandlers.onHitlDisconnect?.({
        phase: "error",
        reason: "socket lost"
      });
    });
    expect(result.current.backendConnectionState).toBe("disconnected");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalledTimes(2);

    const event = requiredHitlEvent();
    if (event.type !== "decision" || !event.item) {
      throw new Error("Test event must include a HITL item.");
    }
    const item = event.item;

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "snapshot",
        items: [item],
        emittedAt: "2026-06-12T12:00:05.000Z"
      });
    });

    expect(result.current.hitlWidgets).toHaveLength(1);
  });

  it("does not show the global polling fallback when the optional HITL stream disconnects", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());
    expect(result.current.backendConnectionState).toBe("connecting");

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "ready",
        emittedAt: "2026-06-12T12:00:00.000Z"
      });
    });
    expect(result.current.backendConnectionState).toBe("connected");

    act(() => {
      mocks.streamHandlers.onHitlDisconnect?.({
        phase: "error",
        reason: "HITL stream returned 404"
      });
    });

    await waitFor(() =>
      expect(mocks.frontendLogMock).toHaveBeenCalledWith(
        "warn",
        "hitl stream disconnected during error: HITL stream returned 404"
      )
    );
    expect(result.current.status).not.toBe(
      "Verbindung wird wiederhergestellt... nutze Polling-Fallback."
    );
    expect(result.current.status).not.toBe(
      "Verbindung wird wiederhergestellt… nutze Polling-Fallback."
    );
    expect(result.current.backendConnectionState).toBe("disconnected");
  });

  it("approves SIMULATION HITL decisions inline", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "decision",
        kind: "required",
        decisionId: "proposal::run%3A1::proposal%3A1",
        runId: "run:1",
        proposalId: "proposal:1",
        status: "pending",
        item: {
          decisionId: "proposal::run%3A1::proposal%3A1",
          runId: "run:1",
          proposalId: "proposal:1",
          actionId: "PURCHASE_ORDER",
          title: "PURCHASE ORDER",
          description: "Supplier order needs approval.",
          agent: {
            agentId: "studio-agent:purchase",
            agentName: "Purchase Agent",
            agentAvatarId: 1
          },
          timestamp: "2026-06-12T12:00:00.000Z",
          mode: "SIMULATION",
          status: "pending",
          priority: "high",
          contextSections: [],
          payload: {}
        },
        emittedAt: "2026-06-12T12:00:00.000Z"
      });
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));
    await act(async () => {
      await result.current.approveHitl("proposal::run%3A1::proposal%3A1", "ok");
    });

    expect(mocks.approveHitlDecisionMock).toHaveBeenCalledWith(
      {
        runId: "run:1",
        proposalId: "proposal:1",
        decisionReason: "ok"
      },
      "context-a",
    );
    expect(result.current.status).toBe("HITL-Antwort gesendet.");
    expect(result.current.hitlWidgets).toHaveLength(0);
  });

  it("optimistically closes a HITL card while approval is being sent", async () => {
    const pendingApproval = deferred();
    mocks.approveHitlDecisionMock.mockReturnValueOnce(pendingApproval.promise);
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));
    let approvePromise: Promise<void> | null = null;
    await act(async () => {
      approvePromise = result.current.approveHitl(
        "proposal::run%3A1::proposal%3A1",
        "ok",
      );
    });

    expect(result.current.hitlWidgets).toHaveLength(0);
    expect(result.current.status).toBe("HITL-Antwort wird gesendet...");

    await act(async () => {
      pendingApproval.resolve(undefined);
      await approvePromise;
    });

    expect(result.current.status).toBe("HITL-Antwort gesendet.");
    expect(result.current.hitlWidgets).toHaveLength(0);
  });

  it("restores an optimistically closed HITL card when approval fails", async () => {
    const pendingApproval = deferred();
    mocks.approveHitlDecisionMock.mockReturnValueOnce(pendingApproval.promise);
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));
    let approvePromise: Promise<void> | null = null;
    await act(async () => {
      approvePromise = result.current.approveHitl(
        "proposal::run%3A1::proposal%3A1",
        "ok",
      );
    });
    expect(result.current.hitlWidgets).toHaveLength(0);

    await act(async () => {
      pendingApproval.reject(new Error("backend unavailable"));
      await approvePromise;
    });

    expect(result.current.status).toBe("HITL-Aktion fehlgeschlagen.");
    expect(result.current.hitlWidgets).toHaveLength(1);
  });

  it("removes HITL cards when the backend reports a non-pending status", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
    });
    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(1));

    act(() => {
      mocks.streamHandlers.onHitlEvent?.({
        type: "decision",
        kind: "updated",
        decisionId: "proposal::run%3A1::proposal%3A1",
        runId: "run:1",
        proposalId: "proposal:1",
        status: "approved",
        emittedAt: "2026-06-12T12:00:01.000Z"
      });
    });

    expect(result.current.hitlWidgets).toHaveLength(0);
  });

  it("sends HITL request-more-info responses back to the backend run", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.connectHitlDecisionStreamMock).toHaveBeenCalled());

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
      mocks.streamHandlers.onHitlEvent?.(
        requiredHitlEvent({
          decisionId: "proposal::run%3A2::proposal%3A2",
          runId: "run:2",
          proposalId: "proposal:2",
          title: "SECOND PURCHASE ORDER"
        }),
      );
    });

    await waitFor(() => expect(result.current.hitlWidgets).toHaveLength(2));
    await act(async () => {
      await result.current.requestMoreInfoForHitl(
        "proposal::run%3A1::proposal%3A1",
        " Bitte Lieferantwerk pruefen ",
      );
    });

    expect(mocks.requestMoreInfoForHitlMock).toHaveBeenCalledWith(
      {
        runId: "run:1",
        message: "Bitte Lieferantwerk pruefen"
      },
      "context-a",
    );
    expect(result.current.status).toBe("Rückfrage gesendet. HITL bleibt offen.");
    expect(result.current.hitlWidgets).toHaveLength(2);
    expect(result.current.hitlWidgets[0]?.decisionId).toBe(
      "proposal::run%3A1::proposal%3A1",
    );
  });

  it("uses selected voice and persists TTS off across remounts", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
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
      expect(mocks.speakTextMock).toHaveBeenCalledWith(
        "req-voice",
        "Antwort eins.",
        "echo",
        "context-a",
      )
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

  it("migrates the legacy onyx default to shimmer when available", async () => {
    window.localStorage.setItem("desktop-avatar.ttsVoice", "onyx");
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
    });
    mocks.listTtsVoicesMock.mockResolvedValue(["onyx", "shimmer", "echo"]);

    const { result } = renderHook(() => useDesktopCompanion());

    await waitFor(() => expect(result.current.ttsVoices).toEqual(["onyx", "shimmer", "echo"]));
    expect(result.current.selectedTtsVoice).toBe("shimmer");
    expect(window.localStorage.getItem("desktop-avatar.ttsVoice")).toBe("shimmer");
  });

  it("keeps TTS disabled when bootstrap config disables it even with a stored opt-in", async () => {
    window.localStorage.setItem("desktop-avatar.ttsEnabled", "true");

    const { result } = renderHook(() => useDesktopCompanion());

    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.ttsEnabled).toBe(false));
    expect(window.localStorage.getItem("desktop-avatar.ttsEnabled")).toBe("false");
  });

  it("starts in peek mode by default", async () => {
    window.localStorage.setItem("desktop-avatar.peekPosition", "bottom-left");
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    expect(result.current.peekMode).toBe("peek");
    expect(result.current.peekPosition).toBe("bottom-left");
    expect(mocks.setPeekPositionMock).not.toHaveBeenCalled();
    expect(mocks.setPeekModeMock).toHaveBeenCalledWith(
      "peek",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      false,
      true
    );
  });

  it("does not apply stale peek geometry when unmounted during bootstrap", async () => {
    const bootstrap = deferred<BootstrapState>();
    mocks.getBootstrapStateMock.mockReturnValueOnce(bootstrap.promise);
    const { unmount } = renderHook(() => useDesktopCompanion());

    unmount();
    await act(async () => {
      bootstrap.resolve({
        avatarManifest: null,
        collapsedSize: { width: 235, height: 235 },
        expandedSize: { width: 520, height: 620 },
        ttsEnabled: false,
        transcriptionProvider: "openai-realtime",
        transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
      });
      await bootstrap.promise;
    });

    expect(mocks.setPeekModeMock).not.toHaveBeenCalled();
  });

  it("immediately removes a tray listener that finishes registering after unmount", async () => {
    const registration = deferred<() => void>();
    let lateHandler: (() => void) | null = null;
    const unlisten = vi.fn(() => {
      lateHandler = null;
    });
    mocks.onTrayPeekCollapseMock.mockImplementationOnce((handler: () => void) => {
      lateHandler = handler;
      return registration.promise;
    });
    const { unmount } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.onTrayPeekCollapseMock).toHaveBeenCalledOnce());

    mocks.setPeekModeMock.mockClear();
    unmount();
    await act(async () => {
      registration.resolve(unlisten);
      await registration.promise;
    });

    expect(unlisten).toHaveBeenCalledOnce();
    expect(lateHandler).toBeNull();
    expect(mocks.setPeekModeMock).not.toHaveBeenCalled();
  });

  it("reacts to tray peek collapse/open and position events", async () => {
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());
    await waitFor(() => expect(mocks.streamHandlers.onTrayPeekOpen).not.toBeNull());
    await waitFor(() => expect(result.current.isModeTransitioning).toBe(false));

    act(() => {
      mocks.streamHandlers.onTrayPeekPositionChanged?.("bottom-left");
    });
    await waitFor(() => expect(result.current.peekPosition).toBe("bottom-left"));
    expect(window.localStorage.getItem("desktop-avatar.peekPosition")).toBe("bottom-left");

    act(() => {
      mocks.streamHandlers.onTrayPeekOpen?.();
    });
    await waitFor(() => expect(result.current.peekMode).toBe("expanded"), {
      timeout: 10_000
    });

    act(() => {
      mocks.streamHandlers.onTrayPeekCollapse?.();
    });
    await waitFor(() => expect(result.current.peekMode).toBe("peek"), {
      timeout: 10_000
    });
  }, 15_000);

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

  it("continues clarification chips as immutable child turns", async () => {
    mocks.createRequestMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-parent",
      conversationId: "conversation-1",
      status: "RECEIVED",
      streamUrl: "/stream/req-parent",
      pollUrl: "/poll/req-parent",
      idempotent: false
    });
    mocks.replyClarificationMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-child",
      conversationId: "conversation-1",
      status: "RECEIVED",
      streamUrl: "/stream/req-child",
      pollUrl: "/poll/req-child",
      idempotent: false
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Zeig mir die Bestellungen");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });
    act(() => {
      mocks.streamHandlers.onEvent?.({
        type: "status",
        avatarRequestId: "req-parent",
        status: "NEEDS_CLARIFICATION",
        emittedAt: "2026-08-14T10:00:00.000Z"
      });
      mocks.streamHandlers.onEvent?.({
        type: "widget",
        avatarRequestId: "req-parent",
        widget: {
          type: "clarification",
          title: "Rückfrage",
          question: "Welcher Zeitraum?",
          suggestions: ["Heute", "Gestern"],
          clarificationId: "clarification-1",
          conversationId: "conversation-1",
          expiresAt: "2099-08-14T11:00:00.000Z"
        },
        emittedAt: "2026-08-14T10:00:01.000Z"
      });
      mocks.streamHandlers.onEvent?.({
        type: "done",
        avatarRequestId: "req-parent",
        status: "NEEDS_CLARIFICATION",
        emittedAt: "2026-08-14T10:00:02.000Z"
      });
    });

    await waitFor(() => {
      expect(result.current.pendingClarification?.clarificationId).toBe(
        "clarification-1"
      );
      expect(result.current.messages[1]?.clarificationState).toBe("pending");
      expect(result.current.status).toBe("Ich benötige noch eine Angabe.");
    });

    await act(async () => {
      await result.current.submitSuggestion("Heute");
    });

    expect(mocks.createRequestMock).toHaveBeenCalledTimes(1);
    expect(mocks.replyClarificationMock).toHaveBeenCalledWith(
      {
        avatarRequestId: "req-parent",
        clarificationId: "clarification-1",
        request: {
          clientRequestId: expect.stringMatching(/^desktop-avatar-client:/),
          answer: "Heute"
        }
      },
      "context-a"
    );
    expect(result.current.messages).toHaveLength(4);
    expect(result.current.messages[1]?.clarificationState).toBe("answered");
    expect(result.current.messages[2]?.text).toBe("Heute");
    expect(result.current.messages[3]?.avatarRequestId).toBe("req-child");
    expect(result.current.pendingClarification).toBeNull();
  });

  it("loads the next dataset page through the active request contract", async () => {
    mocks.getDatasetPageMock.mockResolvedValue({
      resultId: "result-1",
      columns: [{ key: "id", label: "ID", dataType: "string" }],
      rows: [{ id: "B-2" }],
      nextCursor: null,
      totalRowCount: 2
    });
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    const page = await result.current.loadDatasetPage({
      avatarRequestId: "req-dataset",
      resultId: "result-1",
      cursor: "next-page"
    });

    expect(mocks.getDatasetPageMock).toHaveBeenCalledWith(
      {
        avatarRequestId: "req-dataset",
        resultId: "result-1",
        cursor: "next-page"
      },
      "context-a"
    );
    expect(page.totalRowCount).toBe(2);
  });

  it("clears the local conversation without deleting HITL state", async () => {
    mocks.createRequestMock.mockResolvedValue({
      accepted: true,
      avatarRequestId: "req-clear",
      conversationId: "conversation-1",
      status: "RECEIVED",
      streamUrl: "/stream/req-clear",
      pollUrl: "/poll/req-clear",
      idempotent: false
    });

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Welche Bestellungen sind offen?");
    });
    await act(async () => {
      await result.current.submitCurrentDraft();
    });

    act(() => {
      mocks.streamHandlers.onHitlEvent?.(requiredHitlEvent());
      mocks.streamHandlers.onEvent?.({
        type: "talk",
        avatarRequestId: "req-clear",
        talk: { text: "Drei Bestellungen sind offen." },
        emittedAt: "2026-04-09T12:00:01.000Z"
      });
    });

    await waitFor(() => {
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.hitlWidgets).toHaveLength(1);
    });

    await act(async () => {
      await result.current.clearConversation();
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.draft).toBe("");
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.latencyDebug).toBeNull();
    expect(result.current.hitlWidgets).toHaveLength(1);
    expect(mocks.cancelConversationMock).toHaveBeenCalledWith(
      "conversation-1",
      "context-a"
    );
  });

  it("ignores a desktop-avatar create response that resolves after the conversation was cleared", async () => {
    const pendingCreate = deferred<CreateDesktopAvatarRequestResult>();
    mocks.createRequestMock.mockReturnValueOnce(pendingCreate.promise);

    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    act(() => {
      result.current.setDraft("Welche Artikel muss ich nachbestellen?");
    });
    let submitPromise: Promise<void> | null = null;
    act(() => {
      submitPromise = result.current.submitCurrentDraft();
    });

    await waitFor(() => {
      expect(mocks.createRequestMock).toHaveBeenCalledTimes(1);
      expect(result.current.messages).toHaveLength(2);
    });

    await act(async () => {
      await result.current.clearConversation();
    });

    await act(async () => {
      pendingCreate.resolve({
        accepted: true,
        avatarRequestId: "req-cleared-late",
        status: "RECEIVED",
        streamUrl: "/stream/req-cleared-late",
        pollUrl: "/poll/req-cleared-late",
        idempotent: false
      });
      await submitPromise;
    });

    expect(result.current.messages).toHaveLength(0);
    expect(result.current.status).toBeNull();
    expect(mocks.connectStreamMock).not.toHaveBeenCalled();
  });

  it("does not submit a delayed text prompt under a replacement tenant session", async () => {
    const pendingPeekMode = deferred();
    const { result } = renderHook(() => useDesktopCompanion());
    await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

    mocks.setPeekModeMock.mockClear();
    mocks.setPeekModeMock.mockReturnValueOnce(pendingPeekMode.promise);
    act(() => {
      result.current.setDraft("Welche Bestellungen sind offen?");
    });

    let submitPromise: Promise<void> | null = null;
    act(() => {
      submitPromise = result.current.submitCurrentDraft();
    });
    await waitFor(() => expect(mocks.setPeekModeMock).toHaveBeenCalledTimes(1));

    const replacementTenant = {
      tenantId: "tenant-b",
      companyId: "701",
      companyName: "Company B",
      branchId: "1",
      branchName: "Branch 1",
      canAdminister: true
    };
    activateTenantSession({
      contextId: "context-b",
      localEpoch: 2,
      publicSession: {
        sessionId: "session-b",
        user: { id: "user-b", username: "bob", globalAuthorities: [] },
        selectedTenant: replacementTenant,
        accessibleTenants: [replacementTenant],
        administrableTenantIds: [replacementTenant.tenantId],
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    });

    await act(async () => {
      pendingPeekMode.resolve();
      await submitPromise;
    });

    expect(mocks.createRequestMock).not.toHaveBeenCalled();
  });

  it("routes every business prompt through Agent Studio", async () => {
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
  });

  it("tracks actual TTS provider and fallback usage in latency debug", async () => {
    mocks.getBootstrapStateMock.mockResolvedValue({
      avatarManifest: null,
      collapsedSize: { width: 520, height: 780 },
      expandedSize: { width: 520, height: 920 },
      ttsEnabled: true,
      transcriptionProvider: "openai-realtime",
      transcriptionProviders: ["openai-realtime", "openai-file-fallback"]
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
        null,
        "context-a",
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
      requestedBy: "desktop-avatar",
      mode: "SIMULATION",
      modality: "chat",
      utterance: "Welche Bestellungen sind offen?",
      responseModes: ["talk", "widget"],
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
      error: null,
      createdAt: "2026-08-25T10:00:00.000Z",
      updatedAt: "2026-08-25T10:00:01.000Z"
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

  it("surfaces unsupported/no-match Agent Studio errors", async () => {
    mocks.createRequestMock.mockRejectedValueOnce(
      "SYNTRA Assistant create returned 409 Conflict: No active studio agents support READ_SQL_SERVER_QUERY."
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
      expect(result.current.error).toContain("No active studio agents support");
      expect(result.current.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(result.current.messages.filter((message) => message.role === "user")).toHaveLength(1);
    });
  });

  it("surfaces technical Agent Studio errors", async () => {
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

  it("stops TTS before recording and requests processed mono microphone input", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    const originalMediaRecorder = globalThis.MediaRecorder;
    const originalAudioContext = globalThis.AudioContext;

    const trackStopMock = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStopMock }]
    } as unknown as MediaStream;

    const getUserMediaMock = vi.fn(async () => stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaMock }
    });

    class FakeAudioContext {
      public state: AudioContextState = "running";
      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn()
        } as unknown as MediaStreamAudioSourceNode;
      }
      createAnalyser() {
        return {
          fftSize: 2048,
          getFloatTimeDomainData: (buffer: Float32Array) => {
            buffer.fill(0.05);
          }
        } as unknown as AnalyserNode;
      }
      async close() {
        this.state = "closed";
      }
    }

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      public state: RecordingState = "inactive";
      public mimeType = "audio/webm;codecs=opus";
      public ondataavailable: ((event: BlobEvent) => void) | null = null;
      public onstop: (() => void | Promise<void>) | null = null;

      constructor(
        readonly _stream: MediaStream,
        readonly _options?: MediaRecorderOptions
      ) {}

      start() {
        this.state = "recording";
      }

      stop() {
        this.state = "inactive";
        void this.onstop?.();
      }
    }

    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;

    try {
      const { result } = renderHook(() => useDesktopCompanion());
      await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

      await act(async () => {
        await result.current.toggleRecording();
      });

      expect(mocks.stopSpeakingMock).toHaveBeenCalledTimes(1);
      expect(getUserMediaMock).toHaveBeenCalledWith({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      expect(mocks.stopSpeakingMock.mock.invocationCallOrder[0]).toBeLessThan(
        getUserMediaMock.mock.invocationCallOrder[0]
      );
      expect(result.current.isRecording).toBe(true);

      await act(async () => {
        await result.current.toggleRecording();
      });

      await waitFor(() => expect(result.current.isRecording).toBe(false));
      expect(trackStopMock).toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices
      });
      globalThis.MediaRecorder = originalMediaRecorder;
      globalThis.AudioContext = originalAudioContext;
    }
  });

  it("discards microphone access that resolves after the tenant session changed", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    const pendingMedia = deferred<MediaStream>();
    const trackStopMock = vi.fn();
    const stream = {
      getTracks: () => [{ stop: trackStopMock }]
    } as unknown as MediaStream;
    const getUserMediaMock = vi.fn(() => pendingMedia.promise);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaMock }
    });

    try {
      const { result } = renderHook(() => useDesktopCompanion());
      await waitFor(() => expect(mocks.getBootstrapStateMock).toHaveBeenCalled());

      let recordingPromise: Promise<void> | null = null;
      act(() => {
        recordingPromise = result.current.toggleRecording();
      });
      await waitFor(() => expect(getUserMediaMock).toHaveBeenCalledTimes(1));

      const replacementTenant = {
        tenantId: "tenant-b",
        companyId: "701",
        companyName: "Company B",
        branchId: "1",
        branchName: "Branch 1",
        canAdminister: true
      };
      activateTenantSession({
        contextId: "context-b",
        localEpoch: 2,
        publicSession: {
          sessionId: "session-b",
          user: { id: "user-b", username: "bob", globalAuthorities: [] },
          selectedTenant: replacementTenant,
          accessibleTenants: [replacementTenant],
          administrableTenantIds: [replacementTenant.tenantId],
          expiresAt: "2099-01-01T00:00:00.000Z"
        }
      });

      await act(async () => {
        pendingMedia.resolve(stream);
        await recordingPromise;
      });

      expect(trackStopMock).toHaveBeenCalledTimes(1);
      expect(mocks.startTranscriptionSessionMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices
      });
    }
  });
});
