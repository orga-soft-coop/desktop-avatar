import { useState, type ReactNode } from "react";

interface DataPanelSliderProps {
  children: ReactNode[];
  onClose: () => void;
}

export function DataPanelSlider({ children, onClose }: DataPanelSliderProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const count = children.length;

  if (count === 0) {
    return null;
  }

  const goPrev = () => setActiveIndex((i) => (i - 1 + count) % count);
  const goNext = () => setActiveIndex((i) => (i + 1) % count);

  // Single slide — no pagination needed
  if (count === 1) {
    return <div className="data-panel-slider">{children[0]}</div>;
  }

  return (
    <div className="data-panel-slider">
      <div className="data-panel-slider__viewport">
        {children[activeIndex]}
      </div>

      <nav className="data-panel-slider__nav">
        <button
          className="data-panel-slider__arrow"
          type="button"
          onClick={goPrev}
          title="Previous"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>

        <div className="data-panel-slider__dots">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`data-panel-slider__dot ${i === activeIndex ? "is-active" : ""}`}
              onClick={() => setActiveIndex(i)}
              title={`Slide ${i + 1}`}
            />
          ))}
        </div>

        <button
          className="data-panel-slider__arrow"
          type="button"
          onClick={goNext}
          title="Next"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </nav>
    </div>
  );
}
