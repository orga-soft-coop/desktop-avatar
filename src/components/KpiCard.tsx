import { t } from "../lib/i18n";

interface KpiMetric {
  label: string;
  value: string;
  change?: string;
  tone?: "positive" | "warning" | "neutral";
}

interface KpiCardProps {
  title: string;
  subtitle?: string;
  metrics: KpiMetric[];
  onClose?: () => void;
}

export function KpiCard({ title, subtitle, metrics, onClose }: KpiCardProps) {
  return (
    <section className="kpi-card">
      <header className="kpi-card__header">
        <div>
          <p className="kpi-card__eyebrow">{subtitle ?? t("widgets.businessMetrics")}</p>
          <h4 className="kpi-card__title">{title}</h4>
        </div>
        {onClose ? (
          <button className="kpi-card__close" type="button" onClick={onClose} title={t("widgets.dismiss")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        ) : null}
      </header>

      <div className="kpi-card__grid">
        {metrics.map((metric) => (
          <div key={metric.label} className="kpi-card__metric">
            <span className="kpi-card__metric-value">{metric.value}</span>
            <span className="kpi-card__metric-label">{metric.label}</span>
            {metric.change ? (
              <span className="kpi-card__metric-change" data-tone={metric.tone ?? "neutral"}>
                {metric.change}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- Demo data ----

const DEMO_METRICS: KpiMetric[] = [
  { label: t("widgets.revenue"), value: "€48.290", change: "+12,4%", tone: "positive" },
  { label: t("widgets.orders"), value: "186", change: "+8,1%", tone: "positive" },
  { label: t("widgets.averageOrder"), value: "€259,60", change: "−2,3%", tone: "warning" },
  { label: t("widgets.fulfillment"), value: "94,2%", change: "+1,1%", tone: "positive" },
];

export function DemoKpiCard({ onClose }: { onClose: () => void }) {
  return (
    <KpiCard
      title={t("widgets.weeklyPerformance")}
      subtitle={t("widgets.week11Range")}
      metrics={DEMO_METRICS}
      onClose={onClose}
    />
  );
}
