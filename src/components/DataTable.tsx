import { WidgetHeader } from "./WidgetHeader";

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
        <WidgetHeader
          title={title}
          onClose={onClose}
          className="data-table__header"
          titleClassName="data-table__title"
          closeClassName="data-table__close"
        />
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
