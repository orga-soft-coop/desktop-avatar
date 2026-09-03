import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRadarResponse,
  DesktopAvatarRadarStreamEvent,
  DesktopAvatarRadarStreamLifecycleEvent,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  HitlDecisionInput,
  HitlDecisionStreamEvent,
  HitlDecisionStreamLifecycleEvent,
  HitlRequestMoreInfoInput
} from "./contracts";
import {
  approveHitlDecision,
  createDesktopAvatarRequest,
  getDesktopAvatarRadar,
  getDesktopAvatarRequest,
  onDesktopAvatarRadarStreamEvent,
  onDesktopAvatarRadarStreamLifecycle,
  onHitlDecisionStreamEvent,
  onHitlDecisionStreamLifecycle,
  onDesktopAvatarStreamEvent,
  onDesktopAvatarStreamLifecycle,
  rejectHitlDecision,
  requestMoreInfoForHitl,
  startDesktopAvatarRadarStream,
  startDesktopAvatarStream,
  startHitlDecisionStream,
  stopDesktopAvatarRadarStream,
  stopHitlDecisionStream,
  stopDesktopAvatarStream
} from "./tauri";

export interface DesktopAvatarStreamConnection {
  close: () => Promise<void>;
}

export interface HitlDecisionStreamConnection {
  close: () => Promise<void>;
}

export interface DesktopAvatarRadarStreamConnection {
  close: () => Promise<void>;
}

export interface DesktopAvatarApiClient {
  createRequest: (
    input: CreateDesktopAvatarRequestInput,
    expectedContextId: string
  ) => Promise<CreateDesktopAvatarRequestResult>;
  getRequest: (args: {
    avatarRequestId?: string;
    pollUrl?: string;
  }, expectedContextId: string) => Promise<DesktopAvatarRequestDocument>;
  getRadar: (expectedContextId: string) => Promise<DesktopAvatarRadarResponse>;
  connectStream: (args: {
    avatarRequestId: string;
    streamUrl?: string;
    onEvent: (event: DesktopAvatarStreamEvent) => void;
    onDisconnect: (event: DesktopAvatarStreamLifecycleEvent) => void;
    expectedContextId: string;
  }) => Promise<DesktopAvatarStreamConnection>;
  connectHitlDecisionStream: (args: {
    onEvent: (event: HitlDecisionStreamEvent) => void;
    onDisconnect: (event: HitlDecisionStreamLifecycleEvent) => void;
    expectedContextId: string;
  }) => Promise<HitlDecisionStreamConnection>;
  connectRadarStream: (args: {
    onEvent: (event: DesktopAvatarRadarStreamEvent) => void;
    onDisconnect: (event: DesktopAvatarRadarStreamLifecycleEvent) => void;
    expectedContextId: string;
  }) => Promise<DesktopAvatarRadarStreamConnection>;
  approveHitlDecision: (input: HitlDecisionInput, expectedContextId: string) => Promise<void>;
  rejectHitlDecision: (input: HitlDecisionInput, expectedContextId: string) => Promise<void>;
  requestMoreInfoForHitl: (input: HitlRequestMoreInfoInput, expectedContextId: string) => Promise<void>;
}

export const desktopAvatarApiClient: DesktopAvatarApiClient = {
  createRequest: createDesktopAvatarRequest,
  getRequest: getDesktopAvatarRequest,
  getRadar: getDesktopAvatarRadar,
  async connectStream({ avatarRequestId, streamUrl, onEvent, onDisconnect, expectedContextId }) {
    let unlistenEvents: (() => void) | null = null;
    let unlistenLifecycle: (() => void) | null = null;
    let closed = false;

    try {
      unlistenEvents = await onDesktopAvatarStreamEvent((event) => {
        if (event.avatarRequestId === avatarRequestId) {
          onEvent(event);
        }
      });
      unlistenLifecycle = await onDesktopAvatarStreamLifecycle((event) => {
        if (event.avatarRequestId === avatarRequestId) {
          onDisconnect(event);
        }
      });
      await startDesktopAvatarStream({ avatarRequestId, streamUrl }, expectedContextId);
    } catch (error) {
      unlistenEvents?.();
      unlistenLifecycle?.();
      throw error;
    }

    return {
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        unlistenEvents?.();
        unlistenLifecycle?.();
        await stopDesktopAvatarStream(avatarRequestId, expectedContextId);
      }
    };
  },
  async connectHitlDecisionStream({ onEvent, onDisconnect, expectedContextId }) {
    let unlistenEvents: (() => void) | null = null;
    let unlistenLifecycle: (() => void) | null = null;
    let closed = false;

    try {
      unlistenEvents = await onHitlDecisionStreamEvent(onEvent);
      unlistenLifecycle = await onHitlDecisionStreamLifecycle(onDisconnect);
      await startHitlDecisionStream(expectedContextId);
    } catch (error) {
      unlistenEvents?.();
      unlistenLifecycle?.();
      throw error;
    }

    return {
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        unlistenEvents?.();
        unlistenLifecycle?.();
        await stopHitlDecisionStream(expectedContextId);
      }
    };
  },
  async connectRadarStream({ onEvent, onDisconnect, expectedContextId }) {
    let unlistenEvents: (() => void) | null = null;
    let unlistenLifecycle: (() => void) | null = null;
    let closed = false;

    try {
      unlistenEvents = await onDesktopAvatarRadarStreamEvent(onEvent);
      unlistenLifecycle = await onDesktopAvatarRadarStreamLifecycle(onDisconnect);
      await startDesktopAvatarRadarStream(expectedContextId);
    } catch (error) {
      unlistenEvents?.();
      unlistenLifecycle?.();
      throw error;
    }

    return {
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        unlistenEvents?.();
        unlistenLifecycle?.();
        await stopDesktopAvatarRadarStream(expectedContextId);
      }
    };
  },
  approveHitlDecision,
  rejectHitlDecision,
  requestMoreInfoForHitl
};
