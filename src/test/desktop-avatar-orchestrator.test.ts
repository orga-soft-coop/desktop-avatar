import { describe, expect, it } from "vitest";
import {
  desktopAvatarInitialState,
  reduceDesktopAvatarState
} from "../lib/desktop-avatar-orchestrator";

describe("desktop avatar orchestrator", () => {
  it("enters thinking when create starts", () => {
    const state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "createRequested",
      clientRequestId: "client-1"
    });

    expect(state.phase).toBe("creating");
    expect(state.animation).toBe("thinking");
    expect(state.companionState).toBe("thinking");
  });

  it("applies stream status, talk, widget and done transitions", () => {
    let state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "createAccepted",
      result: {
        accepted: true,
        avatarRequestId: "req-1",
        status: "RECEIVED",
        streamUrl: "/stream",
        pollUrl: "/poll",
        idempotent: false
      }
    });

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "status",
        avatarRequestId: "req-1",
        status: "THINKING",
        message: "Analyse laeuft",
        emittedAt: "2026-04-09T12:00:00.000Z"
      }
    });
    expect(state.companionState).toBe("thinking");
    expect(state.animation).toBe("thinking");

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "talk",
        avatarRequestId: "req-1",
        talk: { text: "Ich habe zwei Treffer gefunden." },
        emittedAt: "2026-04-09T12:00:01.000Z"
      }
    });
    expect(state.talkText).toContain("zwei Treffer");
    expect(state.animation).toBe("talking");
    expect(state.companionState).toBe("speaking");

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "widget",
        avatarRequestId: "req-1",
        widget: {
          type: "table",
          title: "Treffer",
          columns: [{ key: "id", label: "ID" }],
          rows: [{ id: "A-100" }]
        },
        emittedAt: "2026-04-09T12:00:02.000Z"
      }
    });
    expect(state.widget?.type).toBe("table");

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "done",
        avatarRequestId: "req-1",
        status: "COMPLETED",
        emittedAt: "2026-04-09T12:00:03.000Z"
      }
    });
    expect(state.isDone).toBe(true);
    expect(state.phase).toBe("completed");
    expect(state.animation).toBe("idle");
  });

  it("switches to polling fallback and materializes final response from poll snapshots", () => {
    let state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "createAccepted",
      result: {
        accepted: true,
        avatarRequestId: "req-2",
        status: "RECEIVED",
        streamUrl: "/stream",
        pollUrl: "/poll",
        idempotent: false
      }
    });

    state = reduceDesktopAvatarState(state, {
      type: "streamDisconnected",
      reason: "Socket closed"
    });
    expect(state.phase).toBe("polling");

    state = reduceDesktopAvatarState(state, {
      type: "pollingSnapshot",
      document: {
        avatarRequestId: "req-2",
        clientRequestId: "client-2",
        requestedBy: "desktop-avatar",
        mode: "SIMULATION",
        modality: "chat",
        utterance: "Welche Bestellungen sind offen?",
        responseModes: ["talk", "widget"],
        status: "COMPLETED",
        response: {
          talk: { text: "Polling hat das Endergebnis geliefert." },
          widget: {
            type: "text",
            title: "Ergebnis",
            text: "Abgeschlossen"
          },
          followUpQuestions: []
        },
        error: null,
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T10:00:01.000Z"
      }
    });

    expect(state.isDone).toBe(true);
    expect(state.talkText).toContain("Endergebnis");
    expect(state.widget?.type).toBe("text");
  });

  it("keeps a streamed clarification in an explicit awaiting phase", () => {
    let state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "createAccepted",
      result: {
        accepted: true,
        avatarRequestId: "req-clarification",
        conversationId: "conversation-1",
        status: "RECEIVED",
        streamUrl: "/stream",
        pollUrl: "/poll",
        idempotent: false
      }
    });

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "status",
        avatarRequestId: "req-clarification",
        status: "NEEDS_CLARIFICATION",
        emittedAt: "2026-08-14T10:00:00.000Z"
      }
    });
    expect(state.phase).toBe("awaiting-clarification");
    expect(state.isDone).toBe(false);

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "widget",
        avatarRequestId: "req-clarification",
        widget: {
          type: "clarification",
          title: "Rückfrage",
          question: "Welcher Zeitraum?",
          suggestions: ["Heute"],
          clarificationId: "clarification-1",
          conversationId: "conversation-1"
        },
        emittedAt: "2026-08-14T10:00:01.000Z"
      }
    });
    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "done",
        avatarRequestId: "req-clarification",
        status: "NEEDS_CLARIFICATION",
        emittedAt: "2026-08-14T10:00:02.000Z"
      }
    });

    expect(state.conversationId).toBe("conversation-1");
    expect(state.widget?.type).toBe("clarification");
    expect(state.phase).toBe("awaiting-clarification");
    expect(state.isDone).toBe(true);
  });

  it("waits for a clarification payload before treating a polled turn as terminal", () => {
    let state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "pollingSnapshot",
      document: {
        avatarRequestId: "req-polled-clarification",
        clientRequestId: "client-1",
        requestedBy: "desktop-avatar",
        mode: "SIMULATION",
        modality: "chat",
        utterance: "Zeige mir die Bestellungen",
        responseModes: ["talk", "widget"],
        conversationId: "conversation-1",
        status: "NEEDS_CLARIFICATION",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:01.000Z",
        response: {
          talk: { text: "Ich brauche noch einen Zeitraum." },
          followUpQuestions: []
        }
      }
    });

    expect(state.phase).toBe("polling");
    expect(state.isDone).toBe(false);

    state = reduceDesktopAvatarState(state, {
      type: "pollingSnapshot",
      document: {
        avatarRequestId: "req-polled-clarification",
        clientRequestId: "client-1",
        requestedBy: "desktop-avatar",
        mode: "SIMULATION",
        modality: "chat",
        utterance: "Zeige mir die Bestellungen",
        responseModes: ["talk", "widget"],
        conversationId: "conversation-1",
        status: "NEEDS_CLARIFICATION",
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:02.000Z",
        response: {
          talk: { text: "Ich brauche noch einen Zeitraum." },
          widget: {
            type: "clarification",
            title: "Rückfrage",
            question: "Welcher Zeitraum?",
            suggestions: [],
            clarificationId: "clarification-1",
            conversationId: "conversation-1"
          },
          followUpQuestions: []
        }
      }
    });

    expect(state.phase).toBe("awaiting-clarification");
    expect(state.isDone).toBe(true);
  });

  it("surfaces failed states as visible errors", () => {
    const state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "streamEvent",
      event: {
        type: "error",
        avatarRequestId: "req-3",
        error: "Studio agent not found",
        emittedAt: "2026-04-09T12:00:04.000Z"
      }
    });

    expect(state.phase).toBe("failed");
    expect(state.error).toContain("not found");
    expect(state.animation).toBe("attention");
  });

  it("keeps backend status messages unchanged", () => {
    let state = reduceDesktopAvatarState(desktopAvatarInitialState, {
      type: "createAccepted",
      result: {
        accepted: true,
        avatarRequestId: "req-4",
        status: "RECEIVED",
        streamUrl: "/stream",
        pollUrl: "/poll",
        idempotent: false
      }
    });

    state = reduceDesktopAvatarState(state, {
      type: "streamEvent",
      event: {
        type: "status",
        avatarRequestId: "req-4",
        status: "FETCHING_DATA",
        message: "Calculate forecast values from the prepared time-series input.",
        emittedAt: "2026-04-30T10:00:00.000Z"
      }
    });

    expect(state.statusMessage).toBe(
      "Calculate forecast values from the prepared time-series input."
    );
  });
});
