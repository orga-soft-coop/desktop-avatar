import type { DesktopAvatarWidgetPayload } from "../lib/contracts";
import { t } from "../lib/i18n";
import { DataTable } from "./DataTable";
import { WidgetHeader } from "./WidgetHeader";

interface DesktopAvatarWidgetPanelProps {
  widget: DesktopAvatarWidgetPayload;
  followUpQuestions?: string[];
  onSuggestionSelect?: (suggestion: string) => void;
  onDismiss?: () => void;
}

function formatScalar(value: string | number | boolean | null): string {
  if (typeof value === "boolean") {
    return value ? t("widgets.yes") : t("widgets.no");
  }
  if (value === null) {
    return "-";
  }
  return String(value);
}

export function DesktopAvatarWidgetPanel({
  widget,
  followUpQuestions = [],
  onSuggestionSelect,
  onDismiss
}: DesktopAvatarWidgetPanelProps) {
  if (widget.type === "table") {
    return (
      <DataTable
        title={widget.title}
        columns={widget.columns.map((column) => ({
          key: column.key,
          label: column.label
        }))}
        rows={widget.rows}
        onClose={onDismiss}
      />
    );
  }

  if (widget.type === "keyValue") {
    return (
      <section className="widget-card widget-card--key-value">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <dl className="widget-card__list">
          {widget.items.map((item) => (
            <div key={item.key} className="widget-card__list-row">
              <dt>{item.label}</dt>
              <dd>{formatScalar(item.value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  if (widget.type === "text") {
    return (
      <section className="widget-card widget-card--text">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <p className="widget-card__body-text">{widget.text}</p>
        {followUpQuestions.length > 0 ? (
          <div className="widget-card__chips">
            {followUpQuestions.map((question) => (
              <button
                key={question}
                type="button"
                className="widget-card__chip"
                onClick={() => onSuggestionSelect?.(question)}
              >
                {question}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  if (widget.type === "clarification") {
    return (
      <section className="widget-card widget-card--clarification">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <p className="widget-card__body-text">{widget.question}</p>
        <div className="widget-card__chips">
          {widget.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="widget-card__chip"
              onClick={() => onSuggestionSelect?.(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="widget-card widget-card--error">
      <WidgetHeader title={widget.title} onClose={onDismiss} />
      <p className="widget-card__body-text">{widget.message}</p>
    </section>
  );
}
