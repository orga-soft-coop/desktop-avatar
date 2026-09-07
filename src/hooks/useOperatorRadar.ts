import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAvatarOperatorRadarWidget, DesktopAvatarRadarResponse, DesktopAvatarRadarSignal, DesktopAvatarRadarStreamEvent, DesktopAvatarWidgetPayload } from "../lib/contracts";
import { desktopAvatarApiClient, type DesktopAvatarRadarStreamConnection } from "../lib/desktop-avatar-api";
import { frontendLog } from "../lib/tauri";
import { t } from "../lib/i18n";
import { errorMessage } from "../lib/companion-utils";

const OPERATOR_RADAR_POLL_MS = 15_000;
const OPERATOR_RADAR_STREAM_RECONNECT_MS = 5_000;
const OPERATOR_RADAR_SNOOZE_MS = 10 * 60_000;
function toOperatorRadarWidget(
  response: DesktopAvatarRadarResponse,
): DesktopAvatarOperatorRadarWidget {
  return {
    type: "operatorRadar",
    title: t("widgets.radar.title"),
    generatedAt: response.generatedAt,
    summary: response.summary,
    items: response.items,
  };
}

interface RadarSignalControl {
  followed?: boolean;
  completionOnly?: boolean;
  snoozedUntilMs?: number;
}

function isRadarCompletionStatus(status: DesktopAvatarRadarSignal["status"]): boolean {
  return status === "completed" || status === "failed" || status === "blocked";
}

function buildRadarSummaryFromItems(
  response: DesktopAvatarRadarResponse,
  items: DesktopAvatarRadarSignal[],
): DesktopAvatarRadarResponse["summary"] {
  return {
    totalCount: items.length,
    criticalCount: items.filter((item) => item.severity === "critical").length,
    highCount: items.filter((item) => item.severity === "high").length,
    needsApprovalCount: items.filter((item) => item.status === "needsApproval").length,
    runningCount: items.filter((item) => item.status === "running").length,
    failedCount: items.filter(
      (item) => item.status === "failed" || item.status === "blocked",
    ).length,
    ...(items[0] ? { topSignalId: items[0].signalId } : {}),
    ...(items.length === response.items.length && response.summary.topSignalId
      ? { topSignalId: response.summary.topSignalId }
      : {}),
  };
}

function applyRadarSignalControls(input: {
  response: DesktopAvatarRadarResponse;
  controls: Map<string, RadarSignalControl>;
  nowMs: number;
}): DesktopAvatarRadarResponse {
  const visibleItems: DesktopAvatarRadarSignal[] = [];
  for (const item of input.response.items) {
    const control = input.controls.get(item.signalId);
    if (!control) {
      visibleItems.push(item);
      continue;
    }

    const snoozedUntilMs = control.snoozedUntilMs ?? 0;
    if (snoozedUntilMs > 0 && snoozedUntilMs <= input.nowMs) {
      delete control.snoozedUntilMs;
    }

    const isSnoozed = (control.snoozedUntilMs ?? 0) > input.nowMs;
    const waitsForCompletion =
      Boolean(control.completionOnly) && !isRadarCompletionStatus(item.status);
    if (isSnoozed || waitsForCompletion) {
      continue;
    }

    visibleItems.push({
      ...item,
      clientState: {
        ...(control.followed ? { followed: true } : {}),
        ...(control.completionOnly ? { completionOnly: true } : {}),
        ...(control.snoozedUntilMs
          ? { snoozedUntil: new Date(control.snoozedUntilMs).toISOString() }
          : {}),
      },
    });
  }

  return {
    ...input.response,
    summary: buildRadarSummaryFromItems(input.response, visibleItems),
    items: visibleItems,
  };
}

export function useOperatorRadar(tenantContextId: string) {
  const [operatorRadarWidget, setOperatorRadarWidget] =
    useState<DesktopAvatarWidgetPayload | null>(null);
  const [operatorRadarSignalCount, setOperatorRadarSignalCount] = useState(0);
  const operatorRadarConnectionRef =
    useRef<DesktopAvatarRadarStreamConnection | null>(null);
  const operatorRadarVisibleRef = useRef(false);
  const operatorRadarLastResponseRef = useRef<DesktopAvatarRadarResponse | null>(null);
  const operatorRadarSignalControlsRef = useRef(new Map<string, RadarSignalControl>());
  const applyOperatorRadarResponse = useCallback(
    (
      response: DesktopAvatarRadarResponse,
      options?: { showWidget?: boolean; showEmpty?: boolean },
    ) => {
      operatorRadarLastResponseRef.current = response;
      const visibleResponse = applyRadarSignalControls({
        response,
        controls: operatorRadarSignalControlsRef.current,
        nowMs: Date.now(),
      });
      setOperatorRadarSignalCount(visibleResponse.summary.totalCount);

      const shouldRenderWidget = Boolean(
        options?.showWidget || operatorRadarVisibleRef.current,
      );
      if (!shouldRenderWidget) {
        return;
      }
      if (visibleResponse.items.length === 0 && !options?.showEmpty) {
        setOperatorRadarWidget(null);
        return;
      }
      setOperatorRadarWidget(toOperatorRadarWidget(visibleResponse));
    },
    [],
  );

  const fetchOperatorRadar = useCallback(
    async (options?: { showWidget?: boolean; showEmpty?: boolean }) => {
      try {
        const response = await desktopAvatarApiClient.getRadar(tenantContextId);
        applyOperatorRadarResponse(response, options);
      } catch (error) {
        const message = errorMessage(error, t("widgets.radar.errorMessage"));
        setOperatorRadarSignalCount(0);
        if (operatorRadarVisibleRef.current || options?.showWidget) {
          setOperatorRadarWidget({
            type: "error",
            title: t("widgets.radar.title"),
            message,
          });
        }
        void frontendLog("warn", `operator radar unavailable: ${message}`);
      }
    },
    [applyOperatorRadarResponse],
  );

  useEffect(() => {
    void fetchOperatorRadar();
    const intervalId = window.setInterval(() => {
      void fetchOperatorRadar();
    }, OPERATOR_RADAR_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [fetchOperatorRadar]);

  useEffect(() => {
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
        void connectRadarStream();
      }, OPERATOR_RADAR_STREAM_RECONNECT_MS);
    }

    function handleRadarStreamEvent(event: DesktopAvatarRadarStreamEvent): void {
      if (!active) return;
      if (event.type === "snapshot" || event.type === "update") {
        applyOperatorRadarResponse(event.radar);
        return;
      }
      if (event.type === "error") {
        void frontendLog(
          "warn",
          `operator radar stream error: ${event.message}`,
        );
      }
    }

    async function connectRadarStream(): Promise<void> {
      if (!active || connecting) {
        return;
      }
      connecting = true;
      const previousConnection = operatorRadarConnectionRef.current;
      operatorRadarConnectionRef.current = null;
      try {
        await previousConnection?.close().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          void frontendLog(
            "warn",
            `operator radar stream cleanup before reconnect failed: ${message}`,
          );
        });
        const connection = await desktopAvatarApiClient.connectRadarStream({
          expectedContextId: tenantContextId,
          onEvent: handleRadarStreamEvent,
          onDisconnect: (event) => {
            if (!active) {
              return;
            }
            const reason = event.reason ? `: ${event.reason}` : "";
            void frontendLog(
              "warn",
              `operator radar stream disconnected during ${event.phase}${reason}`,
            );
            scheduleReconnect();
          },
        });
        if (!active) {
          void connection.close();
          return;
        }
        operatorRadarConnectionRef.current = connection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void frontendLog("warn", `operator radar stream unavailable: ${message}`);
        scheduleReconnect();
      } finally {
        connecting = false;
      }
    }

    void connectRadarStream();

    return () => {
      active = false;
      clearReconnectTimeout();
      const connection = operatorRadarConnectionRef.current;
      operatorRadarConnectionRef.current = null;
      void connection?.close();
    };
  }, [applyOperatorRadarResponse]);

  const dismissOperatorRadar = useCallback(() => {
    operatorRadarVisibleRef.current = false;
    setOperatorRadarWidget(null);
  }, []);

  const renderCachedOperatorRadar = useCallback((options?: { showEmpty?: boolean }) => {
    const response = operatorRadarLastResponseRef.current;
    if (!response) {
      setOperatorRadarSignalCount(0);
      return;
    }
    const visibleResponse = applyRadarSignalControls({
      response,
      controls: operatorRadarSignalControlsRef.current,
      nowMs: Date.now(),
    });
    setOperatorRadarSignalCount(visibleResponse.summary.totalCount);
    if (!operatorRadarVisibleRef.current) {
      return;
    }
    if (visibleResponse.items.length === 0 && !options?.showEmpty) {
      setOperatorRadarWidget(null);
      return;
    }
    setOperatorRadarWidget(toOperatorRadarWidget(visibleResponse));
  }, []);

  const snoozeOperatorRadarSignal = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      controls.set(signalId, {
        ...current,
        followed: false,
        snoozedUntilMs: Date.now() + OPERATOR_RADAR_SNOOZE_MS,
      });
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );

  const toggleFollowOperatorRadarSignal = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      const nextFollowed = !current.followed;
      if (!nextFollowed && !current.completionOnly && !current.snoozedUntilMs) {
        controls.delete(signalId);
      } else {
        controls.set(signalId, {
          ...current,
          followed: nextFollowed,
          ...(nextFollowed
            ? { completionOnly: false, snoozedUntilMs: undefined }
            : {}),
        });
      }
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );

  const notifyOperatorRadarSignalOnCompletion = useCallback(
    (signalId: string) => {
      const controls = operatorRadarSignalControlsRef.current;
      const current = controls.get(signalId) ?? {};
      controls.set(signalId, {
        ...current,
        followed: false,
        completionOnly: true,
        snoozedUntilMs: undefined,
      });
      renderCachedOperatorRadar({ showEmpty: true });
    },
    [renderCachedOperatorRadar],
  );


  const openOperatorRadar = useCallback(() => {
    operatorRadarVisibleRef.current = true;
    void fetchOperatorRadar({ showWidget: true, showEmpty: true });
  }, [fetchOperatorRadar]);
  return { operatorRadarWidget, operatorRadarSignalCount, openOperatorRadar, dismissOperatorRadar,
    snoozeOperatorRadarSignal, toggleFollowOperatorRadarSignal, notifyOperatorRadarSignalOnCompletion };
}
