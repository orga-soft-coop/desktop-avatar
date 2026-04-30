interface SpeechBubbleProps {
  text: string;
  tone?: "default" | "status" | "error";
  showThinkingIndicator?: boolean;
  onDragStart?: () => void;
}

export function SpeechBubble({
  text,
  tone = "default",
  showThinkingIndicator = false,
  onDragStart
}: SpeechBubbleProps) {
  if (!text.trim()) {
    return null;
  }

  return (
    <div
      className="speech-bubble backdrop-blur"
      data-tone={tone}
      data-tauri-drag-region
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button, textarea, input")) {
          return;
        }
        onDragStart?.();
      }}
    >
      <p>
        {text}
        <span
          className="speech-bubble__thinking"
          data-visible={showThinkingIndicator ? "true" : "false"}
          aria-hidden="true"
          data-testid="speech-bubble-thinking"
        >
          <span className="speech-bubble__thinking-dot" />
          <span className="speech-bubble__thinking-dot" />
          <span className="speech-bubble__thinking-dot" />
        </span>
      </p>
      <span className="speech-bubble__tail" aria-hidden="true" />
    </div>
  );
}
