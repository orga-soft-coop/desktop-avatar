import { t } from "../lib/i18n";

interface WidgetHeaderProps {
  title?: string;
  onClose?: () => void;
  className?: string;
  titleClassName?: string;
  closeClassName?: string;
}

export function WidgetHeader({
  title,
  onClose,
  className = "widget-card__header",
  titleClassName,
  closeClassName = "widget-card__close"
}: WidgetHeaderProps) {
  if (!title && !onClose) {
    return null;
  }

  return (
    <header className={className}>
      {title ? <h4 className={titleClassName}>{title}</h4> : <span className="widget-header__spacer" />}
      {onClose ? (
        <button
          className={closeClassName}
          type="button"
          onClick={onClose}
          title={t("widgets.dismiss")}
          aria-label={t("widgets.dismiss")}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      ) : null}
    </header>
  );
}
