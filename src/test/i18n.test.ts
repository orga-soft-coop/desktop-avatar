import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLocale, setLocale, supportedLocales, t } from "../lib/i18n";

describe("i18n", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setLocale("de");
  });

  afterEach(() => {
    setLocale("de");
    window.localStorage.clear();
  });

  it("keeps German as the default locale", () => {
    expect(getLocale()).toBe("de");
    expect(t("chat.send")).toBe("Senden");
  });

  it("switches to English and resolves placeholders", () => {
    expect(setLocale("en-US")).toBe("en");

    expect(t("chat.send")).toBe("Send");
    expect(
      t("connection.backend.pendingHitl", {
        count: 2,
        backend: t("connection.backend.connected"),
      }),
    ).toBe("2 HITL message(s) waiting. Backend connected.");
  });

  it("falls back to German for unsupported locale identifiers", () => {
    expect(setLocale("fr")).toBe("de");
    expect(t("widgets.hitl.sent")).toBe("HITL-Antwort gesendet.");
  });

  it("exposes supported locales", () => {
    expect(supportedLocales).toEqual(["de", "en"]);
  });
});
