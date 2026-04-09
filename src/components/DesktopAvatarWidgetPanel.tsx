import type { DesktopAvatarWidgetPayload } from "../lib/contracts";
import { DataTable } from "./DataTable";

interface DesktopAvatarWidgetPanelProps {
  widget: DesktopAvatarWidgetPayload;
  followUpQuestions?: string[];
  onSuggestionSelect?: (suggestion: string) => void;
}

function formatScalar(value: string | number | boolean | null): string {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (value === null) {
    return "-";
  }
  return String(value);
}

export function DesktopAvatarWidgetPanel({
  widget,
  followUpQuestions = [],
  onSuggestionSelect
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
      />
    );
  }

  if (widget.type === "keyValue") {
    return (
      <section className="widget-card widget-card--key-value">
        <header className="widget-card__header">
          <h4>{widget.title}</h4>
        </header>
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
        <header className="widget-card__header">
          <h4>{widget.title}</h4>
        </header>
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
        <header className="widget-card__header">
          <h4>{widget.title}</h4>
        </header>
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
      <header className="widget-card__header">
        <h4>{widget.title}</h4>
      </header>
      <p className="widget-card__body-text">{widget.message}</p>
    </section>
  );
}
