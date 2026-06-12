import type { DesktopAvatarWidgetPayload } from "../lib/contracts";
import { t } from "../lib/i18n";
import { DataTable } from "./DataTable";
import { WidgetAreaChart } from "./WidgetAreaChart";
import { WidgetHeader } from "./WidgetHeader";
import { useState } from "react";

interface DesktopAvatarWidgetPanelProps {
  widget: DesktopAvatarWidgetPayload;
  followUpQuestions?: string[];
  onSuggestionSelect?: (suggestion: string) => void;
  onDismiss?: () => void;
  onHitlApprove?: (decisionId: string, reason?: string) => void;
  onHitlReject?: (decisionId: string, reason: string) => void;
  onHitlRequestMoreInfo?: (decisionId: string, message: string) => void;
  onOpenHitl?: (decisionId: string) => void;
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

export function DesktopAvatarWidgetPanel({
  widget,
  followUpQuestions = [],
  onSuggestionSelect,
  onDismiss,
  onHitlApprove,
  onHitlReject,
  onHitlRequestMoreInfo,
  onOpenHitl
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
              onClick={() => onSuggestionSelect?.(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      </section>
    );
  }

  if (widget.type === "areaChart") {
    return <WidgetAreaChart widget={widget} onClose={onDismiss} />;
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
