import type {
  ChatMessage,
  DesktopAvatarDatasetColumn,
  DesktopAvatarDatasetPage,
  DesktopAvatarDatasetWidget,
  DesktopAvatarRadarSignal,
  DesktopAvatarWidgetPayload
} from "../lib/contracts";
import { t } from "../lib/i18n";
import { DataTable } from "./DataTable";
import { WidgetAreaChart } from "./WidgetAreaChart";
import { WidgetHeader } from "./WidgetHeader";
import { useEffect, useState } from "react";

interface DesktopAvatarWidgetPanelProps {
  widget: DesktopAvatarWidgetPayload;
  followUpQuestions?: string[];
  clarificationState?: ChatMessage["clarificationState"];
  onSuggestionSelect?: (suggestion: string) => void;
  onDatasetPageRequest?: (
    resultId: string,
    cursor?: string
  ) => Promise<DesktopAvatarDatasetPage>;
  onDismiss?: () => void;
  onHitlApprove?: (decisionId: string, reason?: string) => void;
  onHitlReject?: (decisionId: string, reason: string) => void;
  onHitlRequestMoreInfo?: (decisionId: string, message: string) => void;
  onOpenHitl?: (decisionId: string) => void;
  onRadarSnooze?: (signalId: string) => void;
  onRadarFollowToggle?: (signalId: string) => void;
  onRadarCompletionOnly?: (signalId: string) => void;
}

function formatScalar(value: string | number | boolean | null): string {
  if (typeof value === "boolean") {
    return value ? t("widgets.yes") : t("widgets.no");
  }
  if (value === null) {
    return "-";
  }
  return String(value);
}

function formatDatasetScalar(
  value: string | number | boolean | null,
  column: DesktopAvatarDatasetColumn,
  locale: string
): string {
  const lookupLabel = column.lookup?.labels[String(value)];
  if (lookupLabel !== undefined) {
    return lookupLabel;
  }

  try {
    if (column.dataType === "number" && typeof value === "number") {
      return new Intl.NumberFormat(locale).format(value);
    }
    if (
      (column.dataType === "date" || column.dataType === "datetime") &&
      typeof value === "string"
    ) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return new Intl.DateTimeFormat(
          locale,
          column.dataType === "datetime"
            ? { dateStyle: "medium", timeStyle: "short" }
            : { dateStyle: "medium" }
        ).format(parsed);
      }
    }
  } catch {
    // Invalid server locale/type metadata must not make the result unreadable.
  }

  return formatScalar(value);
}

function formatRadarTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function radarSourceDetailRows(item: DesktopAvatarRadarSignal): Array<[string, string]> {
  const source = item.source;
  return [
    [t("widgets.radar.detail.source"), source?.label ?? item.kind],
    ...(source?.requestId ? [[t("widgets.radar.detail.request"), source.requestId] as [string, string]] : []),
    ...(item.runId ? [[t("widgets.radar.detail.run"), item.runId] as [string, string]] : []),
    ...(item.proposalId
      ? [[t("widgets.radar.detail.proposal"), item.proposalId] as [string, string]]
      : []),
    ...(item.decisionId
      ? [[t("widgets.radar.detail.decision"), item.decisionId] as [string, string]]
      : []),
    ...(item.actionId ? [[t("widgets.radar.detail.action"), item.actionId] as [string, string]] : []),
    ...(source?.status ? [[t("widgets.radar.detail.status"), source.status] as [string, string]] : [])
  ];
}

export function DesktopAvatarWidgetPanel({
  widget,
  followUpQuestions = [],
  clarificationState,
  onSuggestionSelect,
  onDatasetPageRequest,
  onDismiss,
  onHitlApprove,
  onHitlReject,
  onHitlRequestMoreInfo,
  onOpenHitl,
  onRadarSnooze,
  onRadarFollowToggle,
  onRadarCompletionOnly
}: DesktopAvatarWidgetPanelProps) {
  if (widget.type === "table") {
    return (
      <DataTable
        title={widget.title}
        columns={widget.columns.map((column) => ({
          key: column.key,
          label: column.label
        }))}
        rows={widget.rows}
        onClose={onDismiss}
      />
    );
  }

  if (widget.type === "keyValue") {
    return (
      <section className="widget-card widget-card--key-value backdrop-blur">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <dl className="widget-card__list">
          {widget.items.map((item) => (
            <div key={item.key} className="widget-card__list-row">
              <dt>{item.label}</dt>
              <dd>{formatScalar(item.value)}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  if (widget.type === "dataset") {
    return (
      <DatasetCard
        widget={widget}
        onClose={onDismiss}
        onPageRequest={onDatasetPageRequest}
      />
    );
  }

  if (widget.type === "text") {
    return (
      <section className="widget-card widget-card--text backdrop-blur">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <p className="widget-card__body-text">{widget.text}</p>
        {followUpQuestions.length > 0 ? (
          <div className="widget-card__chips">
            {followUpQuestions.map((question) => (
              <button
                key={question}
                type="button"
                className="widget-card__chip"
                onClick={() => onSuggestionSelect?.(question)}
              >
                {question}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  if (widget.type === "clarification") {
    const clarificationDisabled =
      clarificationState === "submitting" ||
      clarificationState === "answered" ||
      clarificationState === "expired" ||
      clarificationState === "unavailable";
    return (
      <section className="widget-card widget-card--clarification backdrop-blur">
        <WidgetHeader title={widget.title} onClose={onDismiss} />
        <p className="widget-card__body-text">{widget.question}</p>
        <div className="widget-card__chips">
          {widget.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="widget-card__chip"
              disabled={clarificationDisabled}
              onClick={() => onSuggestionSelect?.(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
        {clarificationState ? (
          <p className="widget-card__clarification-status" role="status">
            {t(`widgets.clarification.${clarificationState}`)}
          </p>
        ) : null}
      </section>
    );
  }

  if (widget.type === "areaChart") {
    return <WidgetAreaChart widget={widget} onClose={onDismiss} />;
  }

  if (widget.type === "operatorRadar") {
    return (
      <OperatorRadarCard
        widget={widget}
        onClose={onDismiss}
        onOpenHitl={onOpenHitl}
        onRadarSnooze={onRadarSnooze}
        onRadarFollowToggle={onRadarFollowToggle}
        onRadarCompletionOnly={onRadarCompletionOnly}
      />
    );
  }

  if (widget.type === "hitlApproval") {
    return (
      <HitlApprovalCard
        widget={widget}
        onClose={onDismiss}
        onApprove={onHitlApprove}
        onReject={onHitlReject}
        onRequestMoreInfo={onHitlRequestMoreInfo}
        onOpenHitl={onOpenHitl}
      />
    );
  }

  return (
    <section className="widget-card widget-card--error backdrop-blur">
      <WidgetHeader title={widget.title} onClose={onDismiss} />
      <p className="widget-card__body-text">{widget.message}</p>
    </section>
  );
}

function DatasetCard({
  widget,
  onClose,
  onPageRequest
}: {
  widget: DesktopAvatarDatasetWidget;
  onClose?: () => void;
  onPageRequest?: (
    resultId: string,
    cursor?: string
  ) => Promise<DesktopAvatarDatasetPage>;
}) {
  const [columns, setColumns] = useState(widget.columns);
  const [rows, setRows] = useState(widget.rows);
  const [nextCursor, setNextCursor] = useState<string | null>(widget.cursor ?? null);
  const [totalRowCount, setTotalRowCount] = useState(widget.rowCount);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setColumns(widget.columns);
    setRows(widget.rows);
    setNextCursor(widget.cursor ?? null);
    setTotalRowCount(widget.rowCount);
    setLoadError(null);
  }, [widget.columns, widget.cursor, widget.resultId, widget.rowCount, widget.rows]);

  const loadMore = async () => {
    if (!onPageRequest || !nextCursor || loading) {
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const page = await onPageRequest(widget.resultId, nextCursor);
      if (page.resultId !== widget.resultId) {
        throw new Error(t("widgets.dataset.unexpectedResult"));
      }
      setColumns(page.columns);
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.nextCursor);
      setTotalRowCount(page.totalRowCount);
    } catch (caughtError) {
      setLoadError(
        caughtError instanceof Error
          ? caughtError.message
          : t("widgets.dataset.loadFailed")
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dataset-widget">
      <DataTable
        title={widget.title}
        columns={columns.map((column) => ({
          key: column.key,
          label: column.label,
          align: column.dataType === "number" ? "right" as const : "left" as const,
          render: (value: unknown) => {
            const scalar =
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value === null
                ? value
                : value === undefined
                  ? null
                  : String(value);
            return formatDatasetScalar(scalar, column, widget.locale);
          }
        }))}
        rows={rows}
        onClose={onClose}
      />
      <footer className="dataset-widget__paging">
        <span>
          {t("widgets.dataset.loadedRows", {
            loaded: rows.length,
            total: totalRowCount
          })}
        </span>
        {nextCursor ? (
          <button
            type="button"
            className="data-table__pager-btn"
            disabled={loading || !onPageRequest}
            onClick={() => void loadMore()}
          >
            {loading ? t("widgets.dataset.loading") : t("widgets.dataset.loadMore")}
          </button>
        ) : null}
      </footer>
      {loadError ? (
        <p className="dataset-widget__error" role="alert">{loadError}</p>
      ) : null}
    </div>
  );
}

function OperatorRadarCard({
  widget,
  onClose,
  onOpenHitl,
  onRadarSnooze,
  onRadarFollowToggle,
  onRadarCompletionOnly
}: {
  widget: Extract<DesktopAvatarWidgetPayload, { type: "operatorRadar" }>;
  onClose?: () => void;
  onOpenHitl?: (decisionId: string) => void;
  onRadarSnooze?: (signalId: string) => void;
  onRadarFollowToggle?: (signalId: string) => void;
  onRadarCompletionOnly?: (signalId: string) => void;
}) {
  const topSignal = widget.items[0] ?? null;
  const hasSignals = widget.items.length > 0;
  const [expandedSignalId, setExpandedSignalId] = useState<string | null>(null);
  return (
    <section className="widget-card widget-card--radar backdrop-blur">
      <WidgetHeader title={widget.title} onClose={onClose} />
      {hasSignals ? (
        <div className="widget-card__radar-summary" aria-label={t("widgets.radar.summary")}>
          <span>{t("widgets.radar.total", { count: widget.summary.totalCount })}</span>
          <span>{t("widgets.radar.approvals", { count: widget.summary.needsApprovalCount })}</span>
          <span>{t("widgets.radar.running", { count: widget.summary.runningCount })}</span>
          <span>{t("widgets.radar.failed", { count: widget.summary.failedCount })}</span>
        </div>
      ) : null}
      {topSignal ? (
        <div className="widget-card__radar-top" data-severity={topSignal.severity}>
          <span className="widget-card__radar-kicker">
            {t(`widgets.radar.severity.${topSignal.severity}`)}
          </span>
          <strong>{topSignal.title}</strong>
          <p>{topSignal.description}</p>
        </div>
      ) : (
        <p className="widget-card__body-text">{t("widgets.radar.empty")}</p>
      )}
      {widget.items.length > 0 ? (
        <div className="widget-card__radar-list">
          {widget.items.map((item) => (
            <article
              key={item.signalId}
              className="widget-card__radar-item"
              data-severity={item.severity}
            >
              <div className="widget-card__radar-item-header">
                <span className="widget-card__radar-agent">{item.agentName}</span>
                <span className="widget-card__radar-status">
                  {t(`widgets.radar.status.${item.status}`)}
                </span>
              </div>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
              <div className="widget-card__radar-meta">
                <span>{formatRadarTimestamp(item.updatedAt)}</span>
                <span>{t(`widgets.radar.audience.${item.audience.scope}`)}</span>
                {item.actionId ? <span>{item.actionId}</span> : null}
              </div>
              <div className="widget-card__radar-actions">
                <button
                  type="button"
                  className="widget-card__chip widget-card__radar-open"
                  aria-expanded={expandedSignalId === item.signalId}
                  onClick={() =>
                    setExpandedSignalId((current) =>
                      current === item.signalId ? null : item.signalId,
                    )
                  }
                >
                  {expandedSignalId === item.signalId
                    ? t("widgets.radar.hideDetails")
                    : t("widgets.radar.showDetails")}
                </button>
                {item.severity !== "critical" ? (
                  <button
                    type="button"
                    className="widget-card__chip widget-card__radar-open"
                    onClick={() => onRadarSnooze?.(item.signalId)}
                  >
                    {t("widgets.radar.snooze")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`widget-card__chip widget-card__radar-open ${
                    item.clientState?.followed ? "is-active" : ""
                  }`}
                  onClick={() => onRadarFollowToggle?.(item.signalId)}
                >
                  {item.clientState?.followed
                    ? t("widgets.radar.following")
                    : t("widgets.radar.follow")}
                </button>
                {item.status === "running" ? (
                  <button
                    type="button"
                    className="widget-card__chip widget-card__radar-open"
                    onClick={() => onRadarCompletionOnly?.(item.signalId)}
                  >
                    {t("widgets.radar.completionOnly")}
                  </button>
                ) : null}
                {item.kind === "hitlApproval" && item.decisionId ? (
                  <button
                    type="button"
                    className="widget-card__chip widget-card__radar-open"
                    onClick={() => onOpenHitl?.(item.decisionId!)}
                  >
                    {t("widgets.radar.openHitl")}
                  </button>
                ) : null}
              </div>
              {expandedSignalId === item.signalId ? (
                <RadarSignalDetails item={item} />
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RadarSignalDetails({ item }: { item: DesktopAvatarRadarSignal }) {
  const detailRows = radarSourceDetailRows(item);
  const timeline = item.timeline ?? [];
  return (
    <div className="widget-card__radar-detail">
      <div>
        <span className="widget-card__radar-detail-title">
          {t("widgets.radar.detail.why")}
        </span>
        <p>{item.why ?? t("widgets.radar.detail.whyFallback")}</p>
      </div>
      <dl className="widget-card__radar-detail-grid">
        {detailRows.map(([label, value]) => (
          <div key={`${label}:${value}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {timeline.length > 0 ? (
        <div>
          <span className="widget-card__radar-detail-title">
            {t("widgets.radar.detail.timeline")}
          </span>
          <ol className="widget-card__radar-timeline">
            {timeline.map((event) => (
              <li key={event.id}>
                <time>{formatRadarTimestamp(event.timestamp)}</time>
                <div>
                  <strong>{event.title}</strong>
                  {event.description ? <p>{event.description}</p> : null}
                  {event.status ? <span>{event.status}</span> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function HitlApprovalCard({
  widget,
  onClose,
  onApprove,
  onReject,
  onRequestMoreInfo,
  onOpenHitl
}: {
  widget: Extract<DesktopAvatarWidgetPayload, { type: "hitlApproval" }>;
  onClose?: () => void;
  onApprove?: (decisionId: string, reason?: string) => void;
  onReject?: (decisionId: string, reason: string) => void;
  onRequestMoreInfo?: (decisionId: string, message: string) => void;
  onOpenHitl?: (decisionId: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmExecution, setConfirmExecution] = useState(false);
  const trimmedReason = reason.trim();
  const isExecution = widget.mode === "EXECUTION";
  const canMutate = widget.status === "pending" && Boolean(widget.proposalId);
  const needsExecutionConfirm = isExecution && !confirmExecution;
  const priorityLabel = t(`widgets.hitl.priority.${widget.priority}`);
  const statusLabel = t(`widgets.hitl.status.${widget.status}`);

  return (
    <section className="widget-card widget-card--hitl backdrop-blur">
      <WidgetHeader title={widget.title} onClose={onClose} />
      <div className="widget-card__hitl-alert" data-priority={widget.priority}>
        <div className="widget-card__hitl-alert-main">
          <span className="widget-card__hitl-kicker">{t("widgets.hitl.kicker")}</span>
          <span className="widget-card__hitl-meta">
            {widget.agentName} · {widget.mode} · {statusLabel}
          </span>
        </div>
        <span className="widget-card__hitl-priority" data-priority={widget.priority}>
          {t("widgets.hitl.priorityLabel")}: {priorityLabel}
        </span>
      </div>
      <p className="widget-card__body-text">{widget.description}</p>
      <dl className="widget-card__list">
        <div className="widget-card__list-row">
          <dt>{t("widgets.hitl.run")}</dt>
          <dd>{widget.runId}</dd>
        </div>
        {widget.actionId ? (
          <div className="widget-card__list-row">
            <dt>{t("widgets.hitl.action")}</dt>
            <dd>{widget.actionId}</dd>
          </div>
        ) : null}
      </dl>
      <textarea
        className="widget-card__textarea"
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        placeholder={t("widgets.hitl.reasonPlaceholder")}
      />
      {needsExecutionConfirm ? (
        <p className="widget-card__body-text">{t("widgets.hitl.executionConfirm")}</p>
      ) : null}
      <div className="widget-card__chips">
        {isExecution && canMutate ? (
          <button
            type="button"
            className="widget-card__chip"
            onClick={() => setConfirmExecution(true)}
          >
            {t("widgets.hitl.confirm")}
          </button>
        ) : null}
        <button
          type="button"
          className="widget-card__chip"
          disabled={!canMutate || needsExecutionConfirm}
          onClick={() => onApprove?.(widget.decisionId, trimmedReason || undefined)}
        >
          {t("widgets.hitl.approve")}
        </button>
        <button
          type="button"
          className="widget-card__chip"
          disabled={!canMutate || needsExecutionConfirm || trimmedReason.length === 0}
          onClick={() => onReject?.(widget.decisionId, trimmedReason)}
        >
          {t("widgets.hitl.reject")}
        </button>
        <button
          type="button"
          className="widget-card__chip"
          disabled={trimmedReason.length === 0}
          onClick={() => onRequestMoreInfo?.(widget.decisionId, trimmedReason)}
        >
          {t("widgets.hitl.moreInfo")}
        </button>
        <button
          type="button"
          className="widget-card__chip"
          onClick={() => onOpenHitl?.(widget.decisionId)}
        >
          {t("widgets.hitl.open")}
        </button>
      </div>
    </section>
  );
}
