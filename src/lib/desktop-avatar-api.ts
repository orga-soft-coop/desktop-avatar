import type {
  CreateDesktopAvatarRequestInput,
  CreateDesktopAvatarRequestResult,
  DesktopAvatarRequestDocument,
  DesktopAvatarStreamEvent,
  DesktopAvatarStreamLifecycleEvent
} from "./contracts";
import {
  createDesktopAvatarRequest,
  getDesktopAvatarRequest,
  onDesktopAvatarStreamEvent,
  onDesktopAvatarStreamLifecycle,
  startDesktopAvatarStream,
  stopDesktopAvatarStream
} from "./tauri";

export interface DesktopAvatarStreamConnection {
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
  connectStream: (args: {
    avatarRequestId: string;
    streamUrl?: string;
    onEvent: (event: DesktopAvatarStreamEvent) => void;
    onDisconnect: (event: DesktopAvatarStreamLifecycleEvent) => void;
  }) => Promise<DesktopAvatarStreamConnection>;
}

export const desktopAvatarApiClient: DesktopAvatarApiClient = {
  createRequest: createDesktopAvatarRequest,
  getRequest: getDesktopAvatarRequest,
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
  }
};
