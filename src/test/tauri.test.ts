import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: invokeMock
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock
}));

import {
  createDesktopAvatarRequest,
  onDesktopAvatarStreamEvent,
  onStreamEvent,
  sendLocalChat,
  transcribeAudio
} from "../lib/tauri";

describe("tauri runtime guards", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("returns a noop unlisten callback when tauri is unavailable", async () => {
    const unlisten = await onStreamEvent(() => {});

    expect(typeof unlisten).toBe("function");
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("returns a noop unlisten callback for desktop avatar events when tauri is unavailable", async () => {
    const unlisten = await onDesktopAvatarStreamEvent(() => {});

    expect(typeof unlisten).toBe("function");
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("rejects local chat with a descriptive browser fallback error", async () => {
    await expect(
      sendLocalChat({
        requestId: "request-1",
        prompt: "Hello",
        messages: [{ role: "user", content: "Hello" }]
      })
    ).rejects.toThrow("Lokaler Chat benötigt die Tauri-Desktop-Shell.");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects voice transcription with a descriptive browser fallback error", async () => {
    await expect(
      transcribeAudio({
        audioBase64: "SGVsbG8=",
        mimeType: "audio/webm"
      })
    ).rejects.toThrow("Sprachtranskription benötigt die Tauri-Desktop-Shell.");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects desktop avatar create requests with a descriptive browser fallback error", async () => {
    await expect(
      createDesktopAvatarRequest({
        clientRequestId: "client-1",
        utterance: "Hello",
        responseModes: ["talk", "widget"]
      })
    ).rejects.toThrow("Desktop Avatar Anfrage benötigt die Tauri-Desktop-Shell.");

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
