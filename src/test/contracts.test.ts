import { describe, expect, it } from "vitest";
import type {
  DesktopAvatarResponse,
  DesktopAvatarStreamEvent,
  DesktopAvatarWidgetPayload
} from "../lib/contracts";

describe("desktop avatar contracts", () => {
  it("accepts clarification widgets", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "clarification",
      title: "Rueckfrage",
      question: "Welchen Zeitraum meinst du?",
      suggestions: ["Heute", "Gestern"]
    };

    expect(widget.type).toBe("clarification");
  });

  it("accepts full desktop avatar responses", () => {
    const response: DesktopAvatarResponse = {
      talk: { text: "Ich habe zwei Treffer gefunden." },
      widget: {
        type: "keyValue",
        title: "Zusammenfassung",
        items: [
          { key: "count", label: "Treffer", value: 2 },
          { key: "open", label: "Offen", value: true }
        ]
      },
      followUpQuestions: ["Soll ich die Details oeffnen?"]
    };

    expect(response.widget?.type).toBe("keyValue");
  });

  it("accepts talk stream events", () => {
    const event: DesktopAvatarStreamEvent = {
      type: "talk",
      avatarRequestId: "desktop-avatar-request:01HXYZ",
      talk: { text: "Ich habe 10 Eintraege gefunden." },
      emittedAt: "2026-04-09T12:35:02.000Z"
    };

    expect(event.talk.text).toContain("10");
  });
});
