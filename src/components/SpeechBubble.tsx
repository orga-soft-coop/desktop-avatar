interface SpeechBubbleProps {
  text: string;
  tone?: "default" | "status" | "error";
  onDragStart?: () => void;
}

export function SpeechBubble({
  text,
  tone = "default",
  onDragStart
}: SpeechBubbleProps) {
  if (!text.trim()) {
    return null;
  }

  return (
    <div
      className="speech-bubble"
      data-tone={tone}
      data-tauri-drag-region
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("button, textarea, input")) {
          return;
        }
        onDragStart?.();
      }}
    >
      <p>{text}</p>
      <span className="speech-bubble__tail" aria-hidden="true" />
    </div>
  );
}
