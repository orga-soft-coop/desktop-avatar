import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarConversationCancelResult,
  DesktopAvatarDatasetPage,
  DesktopAvatarRadarResponse,
  DesktopAvatarRadarStreamEvent,
  DesktopAvatarRadarStreamLifecycleEvent,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent,
  HitlDecisionInput,
  HitlDecisionStreamEvent,
  HitlDecisionStreamLifecycleEvent,
  HitlRequestMoreInfoInput,
  ReplyDesktopAvatarClarificationInput
} from "./contracts";
import {
  approveHitlDecision,
  cancelDesktopAvatarConversation,
  createDesktopAvatarRequest,
  getDesktopAvatarDatasetPage,
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
  replyDesktopAvatarClarification,
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
    input: CreateDesktopAvatarRequestInput
  ) => Promise<CreateDesktopAvatarRequestResult>;
  getRequest: (args: {
    avatarRequestId?: string;
    pollUrl?: string;
  }) => Promise<DesktopAvatarRequestDocument>;
  replyClarification: (args: {
    avatarRequestId: string;
    clarificationId: string;
    request: ReplyDesktopAvatarClarificationInput;
  }) => Promise<CreateDesktopAvatarRequestResult>;
  getDatasetPage: (args: {
    avatarRequestId: string;
    resultId: string;
    cursor?: string;
  }) => Promise<DesktopAvatarDatasetPage>;
  cancelConversation: (
    conversationId: string
  ) => Promise<DesktopAvatarConversationCancelResult>;
  getRadar: () => Promise<DesktopAvatarRadarResponse>;
  connectStream: (args: {
    avatarRequestId: string;
    streamUrl?: string;
    onEvent: (event: DesktopAvatarStreamEvent) => void;
    onDisconnect: (event: DesktopAvatarStreamLifecycleEvent) => void;
  }) => Promise<DesktopAvatarStreamConnection>;
  connectHitlDecisionStream: (args: {
    onEvent: (event: HitlDecisionStreamEvent) => void;
    onDisconnect: (event: HitlDecisionStreamLifecycleEvent) => void;
  }) => Promise<HitlDecisionStreamConnection>;
  connectRadarStream: (args: {
    onEvent: (event: DesktopAvatarRadarStreamEvent) => void;
    onDisconnect: (event: DesktopAvatarRadarStreamLifecycleEvent) => void;
  }) => Promise<DesktopAvatarRadarStreamConnection>;
  approveHitlDecision: (input: HitlDecisionInput) => Promise<void>;
  rejectHitlDecision: (input: HitlDecisionInput) => Promise<void>;
  requestMoreInfoForHitl: (input: HitlRequestMoreInfoInput) => Promise<void>;
}

export const desktopAvatarApiClient: DesktopAvatarApiClient = {
  createRequest: createDesktopAvatarRequest,
  getRequest: getDesktopAvatarRequest,
  replyClarification: replyDesktopAvatarClarification,
  getDatasetPage: getDesktopAvatarDatasetPage,
  cancelConversation: cancelDesktopAvatarConversation,
  getRadar: getDesktopAvatarRadar,
  async connectStream({ avatarRequestId, streamUrl, onEvent, onDisconnect }) {
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
      await startDesktopAvatarStream({ avatarRequestId, streamUrl });
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
        await stopDesktopAvatarStream(avatarRequestId);
      }
    };
  },
  async connectHitlDecisionStream({ onEvent, onDisconnect }) {
    let unlistenEvents: (() => void) | null = null;
    let unlistenLifecycle: (() => void) | null = null;
    let closed = false;

    try {
      unlistenEvents = await onHitlDecisionStreamEvent(onEvent);
      unlistenLifecycle = await onHitlDecisionStreamLifecycle(onDisconnect);
      await startHitlDecisionStream();
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
        await stopHitlDecisionStream();
      }
    };
  },
  async connectRadarStream({ onEvent, onDisconnect }) {
    let unlistenEvents: (() => void) | null = null;
    let unlistenLifecycle: (() => void) | null = null;
    let closed = false;

    try {
      unlistenEvents = await onDesktopAvatarRadarStreamEvent(onEvent);
      unlistenLifecycle = await onDesktopAvatarRadarStreamLifecycle(onDisconnect);
      await startDesktopAvatarRadarStream();
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
        await stopDesktopAvatarRadarStream();
      }
    };
  },
  approveHitlDecision,
  rejectHitlDecision,
  requestMoreInfoForHitl
};
