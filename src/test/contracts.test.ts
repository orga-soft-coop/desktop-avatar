import { describe, expect, it } from "vitest";
import type {
  AvatarManifest,
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

  it("accepts packed GLB avatar manifest shape", () => {
    const manifest: AvatarManifest = {
      modelUrl: "./avatars/female_avatar_1.glb",
      animationMapping: {
        idle: "idle",
        walking: "walking",
        working: "thinking",
        communicating: "communicating",
        "coffee-break": "coffee-break",
        "at-phone": "at-phone",
        "teleport-out": "teleport-out",
        "teleport-in": "teleport-in",
        talking: "talking"
      }
    };

    expect(manifest.modelUrl).toContain(".glb");
    expect(manifest.animationMapping?.working).toBe("thinking");
  });
});
