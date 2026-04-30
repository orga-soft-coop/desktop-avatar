import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DataTable } from "../components/DataTable";

interface RowData {
  id: string;
  timestamp: string;
}

function buildRows(count: number): RowData[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index + 1}`,
    timestamp: "2016-09-19T22:00:00.000Z"
  }));
}

describe("DataTable", () => {
  it("paginates rows with 10 items per page", async () => {
    render(
      <DataTable<RowData>
        title="Forecast"
        columns={[
          { key: "id", label: "ID" },
          { key: "timestamp", label: "Timestamp" }
        ]}
        rows={buildRows(12)}
      />
    );

    expect(screen.getByText("row-1")).toBeInTheDocument();
    expect(screen.getByText("row-10")).toBeInTheDocument();
    expect(screen.queryByText("row-11")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Weiter" }));

    expect(screen.getByText("row-11")).toBeInTheDocument();
    expect(screen.getByText("row-12")).toBeInTheDocument();
    expect(screen.queryByText("row-1")).not.toBeInTheDocument();
    expect(screen.getByText("11-12 von 12")).toBeInTheDocument();
  });

  it("formats ISO timestamp values for table display", () => {
    render(
      <DataTable<RowData>
        title="Forecast"
        columns={[{ key: "timestamp", label: "Timestamp" }]}
        rows={[{ id: "row-1", timestamp: "2016-09-19T22:00:00.000Z" }]}
      />
    );

    expect(screen.queryByText("2016-09-19T22:00:00.000Z")).not.toBeInTheDocument();
    expect(screen.getAllByText(/2016/).length).toBeGreaterThan(0);
  });
});
