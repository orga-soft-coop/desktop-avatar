import { describe, expect, it } from "vitest";
import { routePrompt } from "../lib/router";

describe("routePrompt", () => {
  it("routes business prompts to the backend path", () => {
    expect(routePrompt("Welche Bestellungen sind gestern Nacht eingegangen?")).toBe(
      "backendBusiness"
    );
  });

  it("routes casual prompts locally", () => {
    expect(routePrompt("Tell me a joke about coffee")).toBe("localChat");
  });

  it("routes ambiguous operational prompts to backend review", () => {
    expect(routePrompt("Can you check what happened yesterday?")).toBe(
      "backendReview"
    );
  });

  it("routes forecast prompts to the backend path", () => {
    expect(routePrompt("Gib mir den Forecast fuer naechste Woche")).toBe(
      "backendBusiness"
    );
  });
});
