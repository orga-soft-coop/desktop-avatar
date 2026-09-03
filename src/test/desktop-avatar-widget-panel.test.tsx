import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DesktopAvatarWidgetPanel } from "../components/DesktopAvatarWidgetPanel";

describe("DesktopAvatarWidgetPanel", () => {
  it("appends paged dataset rows and applies lookup labels", async () => {
    const user = userEvent.setup();
    const onPageRequest = vi.fn().mockResolvedValue({
      resultId: "result-1",
      columns: [
        { key: "id", label: "ID", dataType: "string" },
        {
          key: "status",
          label: "Status",
          dataType: "string",
          lookup: { locale: "de-DE", labels: { OPEN: "Offen", CLOSED: "Geschlossen" } }
        }
      ],
      rows: [{ id: "B-2", status: "CLOSED" }],
      nextCursor: null,
      totalRowCount: 2
    });

    render(
      <DesktopAvatarWidgetPanel
        widget={{
          type: "dataset",
          resultId: "result-1",
          title: "Bestellungen",
          locale: "de-DE",
          rowCount: 2,
          columns: [
            { key: "id", label: "ID", dataType: "string" },
            {
              key: "status",
              label: "Status",
              dataType: "string",
              lookup: { locale: "de-DE", labels: { OPEN: "Offen" } }
            }
          ],
          rows: [{ id: "B-1", status: "OPEN" }],
          cursor: "next-page"
        }}
        onDatasetPageRequest={onPageRequest}
      />
    );

    expect(screen.getByText("Offen")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Weitere laden" }));

    expect(onPageRequest).toHaveBeenCalledWith("result-1", "next-page");
    expect(await screen.findByText("B-2")).toBeInTheDocument();
    expect(screen.getByText("Geschlossen")).toBeInTheDocument();
    expect(screen.getByText("2 von 2 Zeilen geladen")).toBeInTheDocument();
  });

  it("disables clarification chips after the answer was accepted", () => {
    render(
      <DesktopAvatarWidgetPanel
        widget={{
          type: "clarification",
          title: "Rückfrage",
          question: "Welcher Zeitraum?",
          suggestions: ["Heute"]
        }}
        clarificationState="answered"
      />
    );

    expect(screen.getByRole("button", { name: "Heute" })).toBeDisabled();
    expect(screen.getByText("Beantwortet")).toBeInTheDocument();
  });
});
