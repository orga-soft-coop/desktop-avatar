import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthCombobox } from "../components/AuthCombobox";

describe("AuthCombobox", () => {
  afterEach(cleanup);

  it("toggles from the chevron and keeps keyboard navigation visible in long lists", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    );
    let lastScrolledId = "";
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        lastScrolledId = this.id;
      }
    });

    try {
      render(
        <AuthCombobox
          label="Firma"
          placeholder="Firma wählen …"
          emptyMessage="Keine Treffer."
          openLabel="Optionen öffnen"
          closeLabel="Optionen schließen"
          options={Array.from({ length: 6 }, (_, index) => ({
            value: String(index + 1),
            label: `Firma ${index + 1}`
          }))}
          value=""
          onChange={onChange}
        />
      );

      await user.click(screen.getByRole("button", { name: "Firma: Optionen öffnen" }));
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Firma: Optionen schließen" }));
      expect(screen.queryByRole("listbox")).toBeNull();

      const combobox = screen.getByRole("combobox", { name: "Firma" });
      await user.click(combobox);
      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
      const activeOptionId = combobox.getAttribute("aria-activedescendant");
      expect(activeOptionId).toMatch(/-option-5$/);
      expect(lastScrolledId).toBe(activeOptionId);

      await user.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledWith("6");
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView
        );
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
      }
    }
  });
});
