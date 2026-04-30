import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { DesktopAvatarAreaChartWidget } from "../lib/contracts";
import { WidgetHeader } from "./WidgetHeader";

interface WidgetAreaChartProps {
  widget: DesktopAvatarAreaChartWidget;
  onClose?: () => void;
}

const FALLBACK_SERIES_COLORS = ["#8de8d8", "#80c7ff", "#f7b267", "#d4a5ff"];

function tooltipValue(value: number | string | null | undefined): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string") {
    return value;
  }
  return "—";
}

export function WidgetAreaChart({ widget, onClose }: WidgetAreaChartProps) {
  const series = widget.series.filter((entry) => entry.key.trim().length > 0);

  return (
    <section className="widget-card widget-card--chart">
      <WidgetHeader title={widget.title} onClose={onClose} />
      <div className="widget-card__chart-wrap">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart
            accessibilityLayer
            data={widget.rows}
            margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
          >
            <defs>
              {series.map((entry, index) => {
                const color = entry.color ?? FALLBACK_SERIES_COLORS[index % FALLBACK_SERIES_COLORS.length];
                const gradientId = `widget-area-gradient-${entry.key}`;
                return (
                  <linearGradient key={gradientId} id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="4%" stopColor={color} stopOpacity={0.48} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.04} />
                  </linearGradient>
                );
              })}
            </defs>

            <CartesianGrid stroke="rgba(255,255,255,0.1)" vertical={false} />
            <XAxis
              dataKey={widget.xKey}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              stroke="rgba(255,255,255,0.55)"
            />
            <YAxis tickLine={false} axisLine={false} width={36} stroke="rgba(255,255,255,0.45)" />
            <Tooltip
              cursor={{ stroke: "rgba(141, 232, 216, 0.45)", strokeWidth: 1 }}
              contentStyle={{
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(7, 10, 18, 0.9)",
                color: "rgba(255,255,255,0.92)"
              }}
              formatter={(value) => tooltipValue(value as number | string | null)}
            />

            {series.map((entry, index) => {
              const color = entry.color ?? FALLBACK_SERIES_COLORS[index % FALLBACK_SERIES_COLORS.length];
              const gradientId = `widget-area-gradient-${entry.key}`;
              return (
                <Area
                  key={entry.key}
                  type="monotone"
                  dataKey={entry.key}
                  name={entry.label}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  connectNulls
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 1 }}
                />
              );
            })}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="widget-card__legend">
        {series.map((entry, index) => {
          const color = entry.color ?? FALLBACK_SERIES_COLORS[index % FALLBACK_SERIES_COLORS.length];
          return (
            <span key={entry.key} className="widget-card__legend-item">
              <span className="widget-card__legend-dot" style={{ backgroundColor: color }} />
              {entry.label}
            </span>
          );
        })}
      </div>

      {widget.summary ? <p className="widget-card__body-text">{widget.summary}</p> : null}
    </section>
  );
}
