import { useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";
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

const ROWS_PER_PAGE = 10;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const ISO_TIME_PATTERN = /[T ]\d{2}:\d{2}/;

function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (needle.length === 0) {
    return true;
  }
  if (haystack.includes(needle)) {
    return true;
  }
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index >= needle.length) {
        return true;
      }
    }
  }
  return false;
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? t("widgets.yes") : t("widgets.no");
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (ISO_DATE_PATTERN.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) {
        return new Intl.DateTimeFormat(
          undefined,
          ISO_TIME_PATTERN.test(trimmed)
            ? { dateStyle: "medium", timeStyle: "short" }
            : { dateStyle: "medium" }
        ).format(parsed);
      }
    }
    return value;
  }
  return String(value);
}

export function DataTable<T>({
  title,
  columns,
  rows,
  onClose
}: DataTableProps<T>) {
  const [pageIndex, setPageIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const searchTokens = useMemo(
    () =>
      normalizeForSearch(searchQuery)
        .split(/\s+/)
        .filter((token) => token.length > 0),
    [searchQuery]
  );
  const filteredRows = useMemo(() => {
    if (searchTokens.length === 0) {
      return rows;
    }
    return rows.filter((row) => {
      const columnValues = columns.map((column) => {
        const value = (row as Record<string, unknown>)[column.key];
        return normalizeForSearch(formatCellValue(value));
      });
      return searchTokens.every((token) =>
        columnValues.some((columnValue) => fuzzyIncludes(columnValue, token))
      );
    });
  }, [rows, columns, searchTokens]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / ROWS_PER_PAGE));
  const clampedPageIndex = Math.min(pageIndex, totalPages - 1);
  const pageStart = clampedPageIndex * ROWS_PER_PAGE;
  const pageRows = useMemo(
    () => filteredRows.slice(pageStart, pageStart + ROWS_PER_PAGE),
    [filteredRows, pageStart]
  );
  const hasPagination = filteredRows.length > ROWS_PER_PAGE;
  const fromRow = filteredRows.length === 0 ? 0 : pageStart + 1;
  const toRow = pageStart + pageRows.length;

  useEffect(() => {
    setPageIndex(0);
  }, [rows.length, searchQuery]);

  return (
    <section className="data-table backdrop-blur">
      <div className="data-table__inner backdrop-blur">
        <WidgetHeader
          title={title}
          onClose={onClose}
          className="data-table__header"
          titleClassName="data-table__title"
          closeClassName="data-table__close"
        />
        <div className="data-table__toolbar">
          <input
            className="data-table__search"
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("widgets.table.searchPlaceholder")}
            aria-label={t("widgets.table.searchPlaceholder")}
          />
        </div>
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
              {pageRows.length === 0 ? (
                <tr>
                  <td
                    className="data-table__empty"
                    colSpan={columns.length}
                    style={{ textAlign: "center" }}
                  >
                    {t("widgets.table.noResults")}
                  </td>
                </tr>
              ) : null}
              {pageRows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => {
                    const value = (row as Record<string, unknown>)[col.key];
                    return (
                      <td
                        key={col.key}
                        style={{ textAlign: col.align ?? "left" }}
                      >
                        {col.render ? col.render(value, row) : formatCellValue(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasPagination ? (
          <footer className="data-table__footer">
            <span className="data-table__meta">
              {t("widgets.table.rowsRange", {
                from: fromRow,
                to: toRow,
                total: filteredRows.length
              })}
            </span>
            <div className="data-table__pager">
              <button
                type="button"
                className="data-table__pager-btn"
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                disabled={clampedPageIndex === 0}
              >
                {t("widgets.table.previousPage")}
              </button>
              <span className="data-table__meta">
                {t("widgets.table.pageXofY", {
                  current: clampedPageIndex + 1,
                  total: totalPages
                })}
              </span>
              <button
                type="button"
                className="data-table__pager-btn"
                onClick={() =>
                  setPageIndex((current) => Math.min(totalPages - 1, current + 1))
                }
                disabled={clampedPageIndex >= totalPages - 1}
              >
                {t("widgets.table.nextPage")}
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </section>
  );
}
