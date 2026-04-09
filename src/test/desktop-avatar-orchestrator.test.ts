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
        error: null
      }
    });

    expect(state.isDone).toBe(true);
    expect(state.talkText).toContain("Endergebnis");
    expect(state.widget?.type).toBe("text");
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
});
