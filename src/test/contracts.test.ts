import { describe, expect, it } from "vitest";
import type {
  AvatarManifest,
  DesktopAvatarResponse,
  DesktopAvatarStreamEvent,
  HitlDecisionStreamEvent,
  DesktopAvatarWidgetPayload
} from "../lib/contracts";

describe("desktop avatar contracts", () => {
  it("accepts clarification widgets", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "clarification",
      title: "Rueckfrage",
      question: "Welchen Zeitraum meinst du?",
      suggestions: ["Heute", "Gestern"],
      clarificationId: "clarification-1",
      conversationId: "conversation-1",
      expiresAt: "2026-08-14T12:00:00.000Z"
    };

    expect(widget.type).toBe("clarification");
  });

  it("accepts paged dataset widgets with typed and localized columns", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "dataset",
      resultId: "result-1",
      title: "Offene Bestellungen",
      locale: "de-DE",
      rowCount: 42,
      columns: [
        { key: "orderNo", label: "Bestellung", dataType: "string" },
        {
          key: "status",
          label: "Status",
          dataType: "string",
          lookup: {
            locale: "de-DE",
            labels: { OPEN: "Offen" }
          }
        },
        { key: "amount", label: "Betrag", dataType: "number", format: "currency:EUR" }
      ],
      rows: [{ orderNo: "A-100", status: "OPEN", amount: 12.5 }],
      cursor: "next-page"
    };

    expect(widget.type).toBe("dataset");
    expect(widget.columns[1]?.lookup?.labels.OPEN).toBe("Offen");
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

  it("accepts area chart widgets", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "areaChart",
      title: "Nachfrage",
      xKey: "monat",
      series: [{ key: "value", label: "Wert" }],
      rows: [
        { monat: "Jan", value: 10 },
        { monat: "Feb", value: 15 }
      ]
    };

    expect(widget.type).toBe("areaChart");
  });

  it("accepts operator radar widgets", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "operatorRadar",
      title: "Operator-Radar",
      generatedAt: "2026-06-14T09:00:00.000Z",
      summary: {
        totalCount: 2,
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
          },
          source: {
            kind: "hitl",
            label: "HITL decision queue",
            decisionId: "decision-1",
            status: "pending"
          },
          why: "Dieses Signal wird angezeigt, weil eine HITL-Entscheidung aktuell offen ist.",
          timeline: [
            {
              id: "decision-1:decision",
              title: "Freigabe erforderlich",
              timestamp: "2026-06-14T09:00:00.000Z",
              status: "high"
            }
          ]
        },
        {
          signalId: "radar:desktop-avatar:request-1",
          kind: "runtimeCompleted",
          severity: "info",
          status: "completed",
          title: "Analyse abgeschlossen",
          description: "Die vom DesktopAvatar ausgelöste Agent-Aktivität wurde abgeschlossen.",
          studioAgentId: "studio-agent:warehouse",
          agentName: "Warehouse Agent",
          agentRole: "DOMAIN",
          runId: "run:2",
          updatedAt: "2026-06-14T09:00:30.000Z",
          audience: {
            scope: "personal"
          }
        }
      ]
    };

    expect(widget.type).toBe("operatorRadar");
    expect(widget.items[0]?.audience.scope).toBe("team");
    expect(widget.items[0]?.source?.kind).toBe("hitl");
    expect(widget.items[0]?.timeline?.[0]?.title).toBe("Freigabe erforderlich");
    expect(widget.items[1]?.status).toBe("completed");
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

  it("accepts HITL approval widgets and stream events", () => {
    const widget: DesktopAvatarWidgetPayload = {
      type: "hitlApproval",
      decisionId: "proposal::run%3A1::proposal%3A1",
      runId: "run:1",
      proposalId: "proposal:1",
      actionId: "PURCHASE_ORDER",
      title: "PURCHASE ORDER",
      description: "Bestellung freigeben.",
      agentName: "Purchase Agent",
      mode: "SIMULATION",
      status: "pending",
      priority: "high",
      contextSections: []
    };
    const event: HitlDecisionStreamEvent = {
      type: "decision",
      kind: "required",
      decisionId: widget.decisionId,
      runId: widget.runId,
      proposalId: widget.proposalId,
      status: "pending",
      item: {
        decisionId: widget.decisionId,
        runId: widget.runId,
        proposalId: widget.proposalId,
        actionId: "PURCHASE_ORDER",
        title: widget.title,
        description: widget.description,
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

    expect(widget.type).toBe("hitlApproval");
    expect(event.kind).toBe("required");
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
