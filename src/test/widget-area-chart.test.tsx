import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WidgetAreaChart } from "../components/WidgetAreaChart";

describe("WidgetAreaChart", () => {
  it("renders title, summary and legend labels", () => {
    render(
      <WidgetAreaChart
        widget={{
          type: "areaChart",
          title: "Demo Nachfrage",
          xKey: "monat",
          series: [
            { key: "nachfrage", label: "Nachfrage" },
            { key: "angebot", label: "Angebot" }
          ],
          rows: [
            { monat: "Jan", nachfrage: 20, angebot: 18 },
            { monat: "Feb", nachfrage: 24, angebot: 21 }
          ],
          summary: "Trend steigend"
        }}
      />
    );

    expect(screen.getByText("Demo Nachfrage")).toBeInTheDocument();
    expect(screen.getByText("Nachfrage")).toBeInTheDocument();
    expect(screen.getByText("Angebot")).toBeInTheDocument();
    expect(screen.getByText("Trend steigend")).toBeInTheDocument();
  });
});
