import type { ReactNode } from "react";
import { t } from "../lib/i18n";

interface DataPanelSliderProps {
  children: ReactNode[];
  activeIndex: number;
  onSelectIndex: (index: number) => void;
}

export function DataPanelSlider({ children, activeIndex, onSelectIndex }: DataPanelSliderProps) {
  const count = children.length;

  if (count === 0) {
    return null;
  }

  const clampedIndex = Math.min(Math.max(activeIndex, 0), count - 1);
  const goPrev = () => onSelectIndex((clampedIndex - 1 + count) % count);
  const goNext = () => onSelectIndex((clampedIndex + 1) % count);

  if (count === 1) {
    return (
      <div className="data-panel-slider">
        <div className="data-panel-slider__viewport">{children[clampedIndex]}</div>
      </div>
    );
  }

  return (
    <div className="data-panel-slider">
      <div className="data-panel-slider__viewport">{children[clampedIndex]}</div>

      <nav className="data-panel-slider__nav" aria-label={t("slider.navigation")}>
        <button
          className="data-panel-slider__arrow"
          type="button"
          onClick={goPrev}
          title={t("slider.previous")}
        >
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
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>

        <div className="data-panel-slider__dots">
          {Array.from({ length: count }, (_, index) => (
            <button
              key={index}
              type="button"
              className={`data-panel-slider__dot ${index === clampedIndex ? "is-active" : ""}`}
              onClick={() => onSelectIndex(index)}
              title={t("slider.slide", { index: index + 1 })}
            />
          ))}
        </div>

        <button
          className="data-panel-slider__arrow"
          type="button"
          onClick={goNext}
          title={t("slider.next")}
        >
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
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </nav>
    </div>
  );
}
