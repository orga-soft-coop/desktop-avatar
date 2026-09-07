import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import type { BackendConnectionState, CompanionState, DesktopAvatarHitlApprovalWidget, HitlDecisionQueueItem, HitlDecisionStreamEvent } from "../lib/contracts";
import { desktopAvatarApiClient, type HitlDecisionStreamConnection } from "../lib/desktop-avatar-api";
import { frontendLog } from "../lib/tauri";
import { t } from "../lib/i18n";

const HITL_STREAM_RECONNECT_MS = 5_000;
const HITL_ANNOUNCEMENT_BATCH_MS = 250;
function toHitlWidget(item: HitlDecisionQueueItem): DesktopAvatarHitlApprovalWidget {
  return {
    type: "hitlApproval",
    decisionId: item.decisionId,
    runId: item.runId,
    ...(item.proposalId ? { proposalId: item.proposalId } : {}),
    ...(item.actionId ? { actionId: item.actionId } : {}),
    title: item.title,
    description: item.description,
    agentName: item.agent.agentName,
    mode: item.mode,
    status: item.status,
    priority: item.priority,
    contextSections: item.contextSections,
  };
}

function upsertHitlWidget(
  widgets: DesktopAvatarHitlApprovalWidget[],
  next: DesktopAvatarHitlApprovalWidget,
): DesktopAvatarHitlApprovalWidget[] {
  const index = widgets.findIndex((widget) => widget.decisionId === next.decisionId);
  if (index < 0) {
    return [...widgets, next];
  }
  return widgets.map((widget, candidateIndex) =>
    candidateIndex === index ? next : widget,
  );
}

interface HitlOptions {
  tenantContextId: string;
  setBackendConnectionState: Dispatch<SetStateAction<BackendConnectionState>>;
  setStatus: Dispatch<SetStateAction<string | null>>;
  setCompanionState: Dispatch<SetStateAction<CompanionState>>;
  ttsEnabledRef: RefObject<boolean>;
  selectedTtsVoiceRef: RefObject<string | null>;
  requestSpeech: (requestId: string, text: string, voice: string | null) => void;
}

export function useHitlDecisions({ tenantContextId, setBackendConnectionState, setStatus, setCompanionState, ttsEnabledRef, selectedTtsVoiceRef, requestSpeech }: HitlOptions) {
  const [hitlWidgets, setHitlWidgets] = useState<DesktopAvatarHitlApprovalWidget[]>([]);
  const hitlDecisionConnectionRef =
    useRef<HitlDecisionStreamConnection | null>(null);
  const announcedHitlDecisionIdsRef = useRef(new Set<string>());
  const pendingHitlAnnouncementsRef = useRef(
    new Map<string, DesktopAvatarHitlApprovalWidget>(),
  );
  const hitlAnnouncementTimeoutRef = useRef<number | null>(null);
  const locallySubmittedHitlDecisionIdsRef = useRef(new Set<string>());
  useEffect(() => {
    function clearHitlAnnouncementTimeout(): void {
      if (hitlAnnouncementTimeoutRef.current === null) {
        return;
      }
      window.clearTimeout(hitlAnnouncementTimeoutRef.current);
      hitlAnnouncementTimeoutRef.current = null;
    }

    function flushHitlAnnouncements(): void {
      hitlAnnouncementTimeoutRef.current = null;
      const widgets = Array.from(pendingHitlAnnouncementsRef.current.values());
      pendingHitlAnnouncementsRef.current.clear();
      if (widgets.length === 0) {
        return;
      }

      const announcement =
        widgets.length === 1
          ? t("widgets.hitl.announcement", { title: widgets[0]!.title })
          : t("widgets.hitl.announcementBatch", { count: widgets.length });
      setStatus(announcement);
      setCompanionState("thinking");
      if (ttsEnabledRef.current) {
        const speechId =
          widgets.length === 1
            ? `hitl:${widgets[0]!.decisionId}`
            : `hitl:batch:${widgets
                .map((widget) => widget.decisionId)
                .join("|")}`;
        requestSpeech(speechId, announcement, selectedTtsVoiceRef.current);
      }
    }

    function scheduleHitlAnnouncement(
      widget: DesktopAvatarHitlApprovalWidget,
    ): void {
      if (announcedHitlDecisionIdsRef.current.has(widget.decisionId)) {
        return;
      }
      announcedHitlDecisionIdsRef.current.add(widget.decisionId);
      pendingHitlAnnouncementsRef.current.set(widget.decisionId, widget);
      if (hitlAnnouncementTimeoutRef.current !== null) {
        return;
      }
      hitlAnnouncementTimeoutRef.current = window.setTimeout(
        flushHitlAnnouncements,
        HITL_ANNOUNCEMENT_BATCH_MS,
      );
    }

    function handleHitlEvent(event: HitlDecisionStreamEvent): void {
      if (!active) return;
      setBackendConnectionState("connected");
      if (event.type === "snapshot") {
        setHitlWidgets(
          event.items
            .filter(
              (item) =>
                item.status === "pending" &&
                !locallySubmittedHitlDecisionIdsRef.current.has(item.decisionId),
            )
            .map((item) => toHitlWidget(item)),
        );
        return;
      }
      if (event.type !== "decision") {
        return;
      }
      if (
        event.kind === "resolved" ||
        event.kind === "execution_started" ||
        event.kind === "execution_finished" ||
        event.status !== "pending"
      ) {
        locallySubmittedHitlDecisionIdsRef.current.delete(event.decisionId);
        pendingHitlAnnouncementsRef.current.delete(event.decisionId);
        if (pendingHitlAnnouncementsRef.current.size === 0) {
          clearHitlAnnouncementTimeout();
        }
        setHitlWidgets((current) =>
          current.filter((widget) => widget.decisionId !== event.decisionId),
        );
        setStatus(t("widgets.hitl.updated"));
        return;
      }
      if (!event.item) {
        return;
      }
      if (locallySubmittedHitlDecisionIdsRef.current.has(event.decisionId)) {
        return;
      }
      const widget = toHitlWidget(event.item);
      setHitlWidgets((current) => upsertHitlWidget(current, widget));
      if (event.kind === "required") {
        scheduleHitlAnnouncement(widget);
      }
    }

    let active = true;
    let reconnectTimeoutId: number | null = null;
    let connecting = false;

    function clearReconnectTimeout(): void {
      if (reconnectTimeoutId === null) {
        return;
      }
      window.clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    function scheduleReconnect(): void {
      if (!active || reconnectTimeoutId !== null) {
        return;
      }
      reconnectTimeoutId = window.setTimeout(() => {
        reconnectTimeoutId = null;
        void connectHitlStream();
      }, HITL_STREAM_RECONNECT_MS);
    }

    async function connectHitlStream(): Promise<void> {
      if (!active || connecting) {
        return;
      }
      connecting = true;
      setBackendConnectionState((current) =>
        current === "connected" ? current : "connecting",
      );
      const previousConnection = hitlDecisionConnectionRef.current;
      hitlDecisionConnectionRef.current = null;
      try {
        await previousConnection?.close().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void frontendLog(
            "warn",
            `hitl stream cleanup before reconnect failed: ${message}`,
          );
        });
        if (!active) return;
        const connection =
          await desktopAvatarApiClient.connectHitlDecisionStream({
            expectedContextId: tenantContextId,
            onEvent: handleHitlEvent,
            onDisconnect: (event) => {
              if (!active) {
                return;
              }
              const reason = event.reason ? `: ${event.reason}` : "";
              setBackendConnectionState("disconnected");
              void frontendLog(
                "warn",
                `hitl stream disconnected during ${event.phase}${reason}`,
              );
              scheduleReconnect();
            },
          });
        if (!active) {
          void connection.close();
          return;
        }
        hitlDecisionConnectionRef.current = connection;
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setBackendConnectionState("unavailable");
        void frontendLog("warn", `hitl stream unavailable: ${message}`);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    }

    void connectHitlStream();

    return () => {
      active = false;
      clearHitlAnnouncementTimeout();
      pendingHitlAnnouncementsRef.current.clear();
      clearReconnectTimeout();
      const connection = hitlDecisionConnectionRef.current;
      hitlDecisionConnectionRef.current = null;
      void connection?.close();
    };
  }, []);
  const findHitlWidget = useCallback(
    (decisionId: string) =>
      hitlWidgets.find((widget) => widget.decisionId === decisionId) ?? null,
    [hitlWidgets],
  );

  const markHitlActionSending = useCallback((decisionId: string) => {
    locallySubmittedHitlDecisionIdsRef.current.add(decisionId);
    setHitlWidgets((current) =>
      current.filter((item) => item.decisionId !== decisionId),
    );
    setStatus(t("widgets.hitl.sending"));
    setCompanionState("thinking");
  }, []);

  const restoreHitlAction = useCallback((widget: DesktopAvatarHitlApprovalWidget) => {
    locallySubmittedHitlDecisionIdsRef.current.delete(widget.decisionId);
    setHitlWidgets((current) => upsertHitlWidget(current, widget));
    setStatus(t("widgets.hitl.actionFailed"));
    setCompanionState("error");
  }, []);

  const markHitlActionSent = useCallback(() => {
    setStatus(t("widgets.hitl.sent"));
    setCompanionState("idle");
  }, []);

  const markHitlMoreInfoSent = useCallback(() => {
    setStatus(t("widgets.hitl.moreInfoSent"));
    setCompanionState("idle");
  }, []);

  const approveHitl = useCallback(
    async (decisionId: string, decisionReason?: string) => {
      const widget = findHitlWidget(decisionId);
      if (!widget?.proposalId) {
        return;
      }
      markHitlActionSending(decisionId);
      try {
        await desktopAvatarApiClient.approveHitlDecision({
          runId: widget.runId,
          proposalId: widget.proposalId,
          ...(decisionReason?.trim()
            ? { decisionReason: decisionReason.trim() }
            : {}),
        }, tenantContextId);
        markHitlActionSent();
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlActionSending, markHitlActionSent, restoreHitlAction],
  );

  const rejectHitl = useCallback(
    async (decisionId: string, decisionReason: string) => {
      const widget = findHitlWidget(decisionId);
      const reason = decisionReason.trim();
      if (!widget?.proposalId || reason.length === 0) {
        return;
      }
      markHitlActionSending(decisionId);
      try {
        await desktopAvatarApiClient.rejectHitlDecision({
          runId: widget.runId,
          proposalId: widget.proposalId,
          decisionReason: reason,
        }, tenantContextId);
        markHitlActionSent();
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlActionSending, markHitlActionSent, restoreHitlAction],
  );

  const requestMoreInfoForHitl = useCallback(
    async (decisionId: string, message: string) => {
      const widget = findHitlWidget(decisionId);
      const trimmed = message.trim();
      if (!widget || trimmed.length === 0) {
        return;
      }
      setStatus(t("widgets.hitl.sending"));
      setCompanionState("thinking");
      try {
        await desktopAvatarApiClient.requestMoreInfoForHitl({
          runId: widget.runId,
          message: trimmed,
        }, tenantContextId);
        markHitlMoreInfoSent();
      } catch {
        restoreHitlAction(widget);
      }
    },
    [findHitlWidget, markHitlMoreInfoSent, restoreHitlAction],
  );

  const openHitl = useCallback((decisionId: string) => {
    const url = `/Hitl?decisionId=${encodeURIComponent(decisionId)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }, []);

  return { hitlWidgets, approveHitl, rejectHitl, requestMoreInfoForHitl, openHitl };
}
