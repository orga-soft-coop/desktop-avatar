import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpeechBubble } from "../components/SpeechBubble";

describe("SpeechBubble", () => {
  it("does not render for empty text", () => {
    const { container } = render(<SpeechBubble text="   " />);
    expect(container.firstChild).toBeNull();
  });

  it("shows thinking indicator when enabled", () => {
    const { container } = render(<SpeechBubble text="Ich denke nach" showThinkingIndicator />);
    const indicator = within(container).getByTestId("speech-bubble-thinking");
    expect(indicator).toHaveAttribute("data-visible", "true");
  });

  it("hides thinking indicator when disabled", () => {
    const { container } = render(
      <SpeechBubble text="Ich denke nach" showThinkingIndicator={false} />
    );
    const indicator = within(container).getByTestId("speech-bubble-thinking");
    expect(indicator).toHaveAttribute("data-visible", "false");
  });
});
