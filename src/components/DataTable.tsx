import { t } from "../lib/i18n";

export interface Column<T> {
  key: keyof T & string;
  label: string;
  align?: "left" | "right";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render?: (value: any, row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  title?: string;
  columns: Column<T>[];
  rows: T[];
  onClose?: () => void;
}

export function DataTable<T>({
  title,
  columns,
  rows,
  onClose
}: DataTableProps<T>) {
  return (
    <section className="data-table">
      <div className="data-table__inner">
        {(title || onClose) ? (
          <header className="data-table__header">
            {title ? <h4 className="data-table__title">{title}</h4> : null}
            {onClose ? (
              <button className="data-table__close" type="button" onClick={onClose} title={t("widgets.dismiss")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            ) : null}
          </header>
        ) : null}
        <div className="data-table__scroll">
          <table>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.key} style={{ textAlign: col.align ?? "left" }}>{col.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => {
                    const value = (row as Record<string, unknown>)[col.key];
                    return (
                      <td key={col.key} style={{ textAlign: col.align ?? "left" }}>
                        {col.render ? col.render(value, row) : String(value ?? "")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---- Dummy data for demo purposes ----

interface DemoOrder {
  orderNumber: string;
  customer: string;
  total: number;
  status: string;
  date: string;
}

const DEMO_ROWS: DemoOrder[] = [
  { orderNumber: "ORD-2491", customer: "Becker GmbH", total: 1_842.50, status: "statusShipped", date: "2026-03-13" },
  { orderNumber: "ORD-2490", customer: "Schmidt & Co.", total: 624.00, status: "statusProcessing", date: "2026-03-13" },
  { orderNumber: "ORD-2489", customer: "Müller AG", total: 3_190.75, status: "statusShipped", date: "2026-03-12" },
  { orderNumber: "ORD-2488", customer: "Weber KG", total: 445.20, status: "statusPending", date: "2026-03-12" },
  { orderNumber: "ORD-2487", customer: "Fischer OHG", total: 1_105.00, status: "statusDelivered", date: "2026-03-11" },
  { orderNumber: "ORD-2486", customer: "Hofmann Ltd.", total: 2_780.30, status: "statusShipped", date: "2026-03-11" },
];

const DEMO_COLUMNS: Column<DemoOrder>[] = [
  { key: "orderNumber", label: t("widgets.order") },
  { key: "customer", label: t("widgets.customer") },
  {
    key: "total",
    label: t("widgets.total"),
    align: "right",
    render: (v) =>
      new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(v as number)
  },
  {
    key: "status",
    label: t("widgets.status"),
    render: (v) => {
      const s = v as string;
      const tone = s === "statusShipped" || s === "statusDelivered" ? "positive" : s === "statusPending" ? "warning" : "neutral";
      return <span className="data-table__badge" data-tone={tone}>{t(`widgets.${s}`)}</span>;
    }
  },
  { key: "date", label: t("widgets.date") },
];

export function DemoDataTable({ onClose }: { onClose: () => void }) {
  return <DataTable title={t("widgets.demoOrdersTitle")} columns={DEMO_COLUMNS} rows={DEMO_ROWS} onClose={onClose} />;
}
