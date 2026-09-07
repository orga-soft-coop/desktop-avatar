import { CompanionDeveloperTools, type CompanionDeveloperToolsProps, type DevToolsSectionKey } from "./CompanionDeveloperTools";
export type { DevToolsDemoWidgetKind } from "./CompanionDeveloperTools";
import { CompanionSettings } from "./CompanionSettings";
import type { AvatarPreference } from "../lib/bundled-avatars";
import { useLayoutEffect, useRef, useState } from "react";
import type {
  BackendConnectionState,
  ChatMessage,
} from "../lib/contracts";
import { t, type LocaleId } from "../lib/i18n";
import { type SizePreset } from "../lib/window-presets";

interface ChatPanelProps extends CompanionDeveloperToolsProps {
  avatarPreference?: AvatarPreference;
  onSelectAvatar?: (avatar: AvatarPreference) => void;
  canStopOutput?: boolean;
  isStoppingOutput?: boolean;
  onStopOutput?: () => void;
  draft: string;
  isExpanded: boolean;
  isRecording: boolean;
  uiTheme: "dark" | "light";
  sizePreset: SizePreset;
  ttsEnabled: boolean;
  backendConnectionState: BackendConnectionState;
  backendConnectionLabel: string;
  radarSignalCount?: number;
  locale?: LocaleId;
  supportedLocales?: LocaleId[];
  ttsVoices?: string[];
  selectedTtsVoice?: string | null;
  messages?: ChatMessage[];
  error?: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onToggleExpanded: () => void;
  onToggleTheme: () => void;
  onOpenRadar?: () => void;
  onToggleTts: () => void;
  onSelectLocale?: (locale: LocaleId) => void;
  onSelectTtsVoice?: (voice: string | null) => void;
  onToggleRecording: () => void;
  onSelectSizePreset: (preset: SizePreset) => void;
  onClearConversation?: () => void;
  onSuggestionSubmit?: (value: string) => void;
  onRetry: () => void;
  onDragStart: () => void;
}

export function ChatPanel({
  canStopOutput = false,
  isStoppingOutput = false,
  onStopOutput,
  avatarPreference,
  onSelectAvatar,
  draft,
  isExpanded,
  isRecording,
  uiTheme,
  sizePreset,
  ttsEnabled,
  backendConnectionState,
  backendConnectionLabel,
  radarSignalCount = 0,
  locale = "de",
  supportedLocales = ["de"],
  ttsVoices,
  selectedTtsVoice,
  messages = [],
  error,
  onDraftChange,
  onSubmit,
  onToggleExpanded,
  onToggleTheme,
  onOpenRadar,
  onToggleTts,
  onSelectLocale,
  onSelectTtsVoice,
  onToggleRecording,
  onSelectSizePreset,
  onClearConversation,
  onSuggestionSubmit,
  onRetry,
  onDragStart,
  ...developerTools
}: ChatPanelProps) {
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<DevToolsSectionKey, boolean>>({
    voice: true,
    latency: false,
    widgetDemo: true,
    animation: false,
    runtime: false,
    window: false,
    camera: false
  });
  const draftTextareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesListRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const [hasNewAnswer, setHasNewAnswer] = useState(false);

  const visibleMessages = messages.filter(
    (message) =>
      message.role !== "system" &&
      (message.text.trim() ||
        message.isStreaming ||
        message.outputStopped ||
        message.widget ||
        (message.followUpQuestions?.length ?? 0) > 0)
  );
  const hasConversation = visibleMessages.length > 0;
  const latestVisibleMessage = visibleMessages[visibleMessages.length - 1] ?? null;
  useLayoutEffect(() => {
    const textarea = draftTextareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const computed = window.getComputedStyle(textarea);
    const maxHeight = Number.parseFloat(computed.maxHeight);
    const hasFiniteMaxHeight = Number.isFinite(maxHeight) && maxHeight > 0;
    const nextHeight = hasFiniteMaxHeight
      ? Math.min(textarea.scrollHeight, maxHeight)
      : textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    if (hasFiniteMaxHeight && textarea.scrollHeight > maxHeight + 1) {
      textarea.style.overflowY = "auto";
    } else {
      textarea.style.overflowY = "hidden";
    }
  }, [draft]);

  const jumpToLatest = () => {
    const list = messagesListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    followTranscriptRef.current = true;
    setHasNewAnswer(false);
  };

  useLayoutEffect(() => {
    if (!latestVisibleMessage) {
      followTranscriptRef.current = true;
      setHasNewAnswer(false);
    } else if (followTranscriptRef.current || latestVisibleMessage.role === "user") {
      jumpToLatest();
    } else {
      setHasNewAnswer(true);
    }
  }, [latestVisibleMessage?.id, latestVisibleMessage?.text, latestVisibleMessage?.isStreaming]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
    if (event.key === "Escape") {
      onToggleExpanded();
    }
  };


  return (
    <section className={`chat-panel ${isExpanded ? "is-expanded" : "is-collapsed"}`}>
      {isExpanded ? (
        <div
          className="chat-panel__dock backdrop-blur"
          data-tauri-drag-region
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest("button, textarea, input, select")) {
              return;
            }
            onDragStart();
          }}
        >
          {error ? (
            <div className="chat-panel__error">
              <span>{error}</span>
              <button type="button" onClick={onRetry} title={t("chat.retry")}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            </div>
          ) : null}

          <div className="chat-panel__composer">
            <textarea
              ref={draftTextareaRef}
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              aria-label={t("chat.placeholder")}
              placeholder={t("chat.placeholder")}
              rows={1}
              autoFocus
            />
            {onStopOutput && (canStopOutput || isStoppingOutput) ? (
              <button type="button" className="chat-panel__stop" disabled={isStoppingOutput}
                onClick={onStopOutput}>{t("chat.stopOutput")}</button>
            ) : <button className="chat-panel__send" type="button" onClick={onSubmit} title={t("chat.send")}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>}
          </div>

          <div className="chat-panel__transcript" aria-label={t("chat.transcript")}>
            <div className="chat-panel__transcript-header">
              <span>{t("chat.transcript")}</span>
              {hasConversation && onClearConversation ? (
                <button
                  className="chat-panel__clear"
                  type="button"
                  onClick={onClearConversation}
                  title={t("chat.newChat")}
                >
                  {t("chat.newChat")}
                </button>
              ) : null}
            </div>
            <div className="chat-panel__messages" ref={messagesListRef} tabIndex={0}
              onScroll={(event) => {
                const list = event.currentTarget;
                const atEnd = list.scrollHeight - list.clientHeight - list.scrollTop <= 40;
                followTranscriptRef.current = atEnd;
                if (atEnd) setHasNewAnswer(false);
              }}
            >
              {hasConversation ? (
                visibleMessages.map((message) => {
                  const hasFollowUps = (message.followUpQuestions?.length ?? 0) > 0;
                  const clarificationDisabled =
                    message.clarificationState === "submitting" ||
                    message.clarificationState === "answered" ||
                    message.clarificationState === "expired" ||
                    message.clarificationState === "unavailable";
                  const assistantText =
                    message.text.trim() ||
                    (message.isStreaming ? t("chat.assistantWorking") : "");
                  const displayText = message.role === "assistant" ? assistantText : message.text;

                  return (
                    <article
                      key={message.id}
                      className="chat-panel__message"
                      data-role={message.role}
                      data-streaming={message.isStreaming ? "true" : "false"}
                    >
                      <div className="chat-panel__message-bubble">
                        {displayText ? <p>{displayText}</p> : null}
                        {message.widget ? (
                          <span className="chat-panel__message-widget">
                            {message.widget.title}
                          </span>
                        ) : null}
                        {hasFollowUps ? (
                          <div className="chat-panel__message-chips">
                            {message.followUpQuestions!.map((question) => (
                              <button
                                key={question}
                                type="button"
                                className="chat-panel__message-chip"
                                disabled={clarificationDisabled}
                                onClick={() => {
                                  if (onSuggestionSubmit) {
                                    onSuggestionSubmit(question);
                                    return;
                                  }
                                  onDraftChange(question);
                                }}
                              >
                                {question}
                              </button>
                            ))}
                          </div>
                        ) : null}
                        {message.outputStopped ? <span role="status">{t("chat.outputStopped")}</span> : null}
                        {message.clarificationState ? (
                          <span className="chat-panel__clarification-status" role="status">
                            {t(`widgets.clarification.${message.clarificationState}`)}
                          </span>
                        ) : null}
                      </div>
                    </article>
                  );
                })
              ) : (
                <div className="chat-panel__empty-transcript">
                  {t("chat.emptyTranscript")}
                </div>
              )}
            </div>
          </div>

          {hasNewAnswer ? (
            <button type="button" className="chat-panel__new-answer" onClick={jumpToLatest}>
              {t("chat.newAnswer")}
            </button>
          ) : null}

          <div className="chat-panel__bar">
            <small className="chat-panel__hint">{t("chat.launcherHint")}</small>

            <div className="chat-panel__actions">
              <span
                className="chat-panel__backend-status"
                data-state={backendConnectionState}
                role="status"
                aria-label={backendConnectionLabel}
                title={backendConnectionLabel}
              >
                <span className="chat-panel__backend-status-dot" aria-hidden="true" />
                <span>{backendConnectionLabel}</span>
              </span>
              {onOpenRadar ? (
                <button
                  type="button"
                  onClick={onOpenRadar}
                  title={t("chat.openRadar")}
                  aria-label={
                    radarSignalCount > 0
                      ? `${t("chat.openRadar")} (${radarSignalCount})`
                      : t("chat.openRadar")
                  }
                  className={radarSignalCount > 0 ? "is-active" : undefined}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M19.1 4.9A10 10 0 0 1 4.9 19.1" />
                    <path d="M4.9 4.9A10 10 0 0 0 19.1 19.1" />
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 12h8" />
                  </svg>
                  {radarSignalCount > 0 ? (
                    <span className="chat-panel__action-badge" aria-hidden="true" />
                  ) : null}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onToggleRecording}
                disabled={isStoppingOutput || (canStopOutput && !isRecording)}
                title={isRecording ? t("chat.stopRecording") : t("chat.voiceInput")}
                className={isRecording ? "is-active" : undefined}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
              <button
                type="button"
                onClick={onToggleTts}
                title={ttsEnabled ? t("chat.muteTts") : t("chat.enableTts")}
                className={ttsEnabled ? "is-active" : undefined}
              >
                {ttsEnabled ? (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={onToggleTheme}
                title={uiTheme === "dark" ? t("chat.switchToLightMode") : t("chat.switchToDarkMode")}
              >
                {uiTheme === "dark" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2" />
                    <path d="M12 20v2" />
                    <path d="m4.93 4.93 1.41 1.41" />
                    <path d="m17.66 17.66 1.41 1.41" />
                    <path d="M2 12h2" />
                    <path d="M20 12h2" />
                    <path d="m6.34 17.66-1.41 1.41" />
                    <path d="m19.07 4.93-1.41 1.41" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 3a6 6 0 0 0 9 8.2 9 9 0 1 1-9-8.2z" />
                  </svg>
                )}
              </button>
              <button type="button" onClick={onToggleExpanded} title={t("chat.toPeek")}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 5v10" />
                  <path d="m8 11 4 4 4-4" />
                  <rect x="5" y="18" width="14" height="2" rx="1" />
                </svg>
              </button>
            </div>
          </div>

          <CompanionSettings locale={locale} supportedLocales={supportedLocales} onSelectLocale={onSelectLocale}
            ttsVoices={ttsVoices} selectedTtsVoice={selectedTtsVoice} onSelectTtsVoice={onSelectTtsVoice}
            sizePreset={sizePreset} onSelectSizePreset={onSelectSizePreset}
            avatarPreference={avatarPreference} onSelectAvatar={onSelectAvatar} />

          <CompanionDeveloperTools {...developerTools} devToolsOpen={devToolsOpen} setDevToolsOpen={setDevToolsOpen}
            openSections={openSections} setOpenSections={setOpenSections} />
        </div>
      ) : (
        <button className="chat-panel__launcher backdrop-blur" type="button" onClick={onToggleExpanded}>
          <span>{draft || t("chat.placeholder")}</span>
          <small>{t("chat.launcherHint")}</small>
        </button>
      )}
    </section>
  );
}
