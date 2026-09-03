import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";

export interface AuthComboboxOption {
  value: string;
  label: string;
}

interface AuthComboboxProps {
  label: string;
  placeholder: string;
  emptyMessage: string;
  openLabel: string;
  closeLabel: string;
  options: AuthComboboxOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function AuthCombobox({
  label,
  placeholder,
  emptyMessage,
  openLabel,
  closeLabel,
  options,
  value,
  disabled = false,
  onChange
}: AuthComboboxProps) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const [placement, setPlacement] = useState<"above" | "below">("below");
  const selected = options.find((option) => option.value === value) ?? null;
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) =>
      `${option.label} ${option.value}`.toLocaleLowerCase().includes(normalized)
    );
  }, [options, query]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    setActiveIndex((current) =>
      filteredOptions.length === 0 ? -1 : Math.min(Math.max(current, 0), filteredOptions.length - 1)
    );
  }, [filteredOptions.length]);

  const positionPanel = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const rect = input.getBoundingClientRect();
    const gap = 6;
    const availableBelow = window.innerHeight - rect.bottom - gap;
    const availableAbove = rect.top - gap;
    const naturalHeight = Math.min(168, Math.max(48, filteredOptions.length * 38 + 12));
    const nextPlacement =
      availableBelow >= naturalHeight || availableBelow >= availableAbove ? "below" : "above";
    const availableHeight = nextPlacement === "below" ? availableBelow : availableAbove;
    setPlacement(nextPlacement);
    setPanelStyle({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(48, Math.min(168, availableHeight)),
      ...(nextPlacement === "below"
        ? { top: rect.bottom + gap, bottom: "auto" }
        : { top: "auto", bottom: window.innerHeight - rect.top + gap })
    });
  }, [filteredOptions.length]);

  useLayoutEffect(() => {
    if (!open) return;
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open, positionPanel]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, filteredOptions.length, open, query]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const choose = (option: AuthComboboxOption) => {
    onChange(option.value);
    close();
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setQuery("");
        setActiveIndex(0);
      } else if (filteredOptions.length > 0) {
        setActiveIndex((current) => (current + 1) % filteredOptions.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setQuery("");
        setActiveIndex(Math.max(0, options.length - 1));
      } else if (filteredOptions.length > 0) {
        setActiveIndex((current) =>
          current <= 0 ? filteredOptions.length - 1 : current - 1
        );
      }
      return;
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) choose(option);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  const optionList = open ? (
    <div
      id={listboxId}
      className="auth-combobox__list"
      role="listbox"
      data-placement={placement}
      style={panelStyle}
    >
      {filteredOptions.length > 0 ? (
        filteredOptions.map((option, index) => (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            id={`${listboxId}-option-${index}`}
            className="auth-combobox__option"
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            data-active={index === activeIndex ? "true" : "false"}
            onPointerDown={(event) => event.preventDefault()}
            onPointerMove={() => setActiveIndex(index)}
            onClick={() => choose(option)}
          >
            <span>{option.label}</span>
            <small>{option.value}</small>
          </button>
        ))
      ) : (
        <p className="auth-combobox__empty">{emptyMessage}</p>
      )}
    </div>
  ) : null;

  return (
    <div className="auth-form-field">
      <label htmlFor={inputId}>{label}</label>
      <div
        className="auth-combobox"
        data-open={open ? "true" : "false"}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) close();
        }}
      >
        <input
          ref={inputRef}
          id={inputId}
          className="auth-combobox__input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={open}
          aria-activedescendant={
            open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
          }
          autoComplete="off"
          value={open ? query : (selected?.label ?? "")}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            setQuery("");
            setOpen(true);
            setActiveIndex(0);
          }}
          onClick={() => {
            if (!open) {
              setQuery("");
              setOpen(true);
              setActiveIndex(0);
            }
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          className="auth-combobox__chevron"
          type="button"
          aria-label={`${label}: ${open ? closeLabel : openLabel}`}
          disabled={disabled}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open) {
              close();
              return;
            }
            inputRef.current?.focus();
            setQuery("");
            setOpen(true);
            setActiveIndex(0);
          }}
        />
      </div>
      {optionList ? createPortal(optionList, document.body) : null}
    </div>
  );
}
