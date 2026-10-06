import { useCallback, useEffect, useRef, useState } from "react";
import type { LearningCaseAssessment, LearningReviewDecisionInput, LearningReviewDetail, LearningReviewPurpose, LearningReviewStatus, LearningReviewSummary } from "../lib/learning-review-contracts";
import { learningReviewsApi, type LearningReviewsApi } from "../lib/learning-reviews-api";
import { isCurrentTenantContext } from "../lib/tenant-session";
import { t } from "../lib/i18n";
import { WidgetHeader } from "./WidgetHeader";

type ReviewGroup = "PENDING" | "CONFIRMED" | "DISCARDED";
function errorStatus(error: unknown): number | undefined {
  if (typeof error === "string") { try { return errorStatus(JSON.parse(error)); } catch { return undefined; } }
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return undefined;
}
function localDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

/** Independent learning state: no business-HITL identifiers or action callbacks. */
function LearningReviewWorkspace({ contextId, onDismiss, api = learningReviewsApi }: {
  contextId: string; onDismiss?: () => void; api?: LearningReviewsApi;
}) {
  const [group, setGroup] = useState<ReviewGroup>("PENDING");
  const [mode, setMode] = useState<"" | "SIMULATION" | "EXECUTION">("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<LearningReviewSummary[]>([]);
  const [cursors, setCursors] = useState<Partial<Record<LearningReviewStatus, string>>>({});
  const [detail, setDetail] = useState<{ contextId: string; value: LearningReviewDetail } | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [purpose, setPurpose] = useState<LearningReviewPurpose>("TASK");
  const [reason, setReason] = useState("");
  const [assessment, setAssessment] = useState<LearningCaseAssessment | "">("");
  const [validFrom, setValidFrom] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const mounted = useRef(false);
  const latestContext = useRef(contextId);
  latestContext.current = contextId;
  const pendingMutation = useRef<{ signature: string; key: string } | null>(null);
  const current = useCallback(() => mounted.current && latestContext.current === contextId && isCurrentTenantContext(contextId), [contextId]);
  const clearDetail = useCallback(() => {
    detailEpoch.current += 1;
    setDetail(null); setBody(""); setReason(""); setAssessment(""); setEditing(false);
    setValidFrom(""); setValidUntil(""); pendingMutation.current = null;
  }, []);
  const clearPrivate = useCallback(() => {
    listEpoch.current += 1; mutationEpoch.current += 1;
    clearDetail(); setItems([]); setCursors({}); setSuccess(false); setLoading(false); setDetailLoading(false); setBusy(false); setConflicted(false);
  }, [clearDetail]);
  useEffect(() => {
    mounted.current = true; clearPrivate(); setError(null); setBusy(false);
    return () => { mounted.current = false; listEpoch.current += 1; detailEpoch.current += 1; mutationEpoch.current += 1; pendingMutation.current = null; };
  }, [contextId, clearPrivate]);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(text.trim()), 250); return () => window.clearTimeout(timer); }, [text]);

  const showFailure = useCallback((failure: unknown) => {
    const status = errorStatus(failure);
    if (status === 401 || status === 403 || status === 404 || String(failure).includes("DESKTOP_SESSION_CHANGED")) {
      clearPrivate(); setError(t("learning.accessLost"));
    } else { setConflicted(status === 409); setError(t(status === 409 ? "learning.conflict" : "learning.failed")); }
  }, [clearPrivate]);
  const loadList = useCallback(async (more: boolean, nextCursors: Partial<Record<LearningReviewStatus, string>> = {}) => {
    const epoch = ++listEpoch.current; setLoading(true); setError(null);
    const statuses: LearningReviewStatus[] = group === "DISCARDED" ? ["REJECTED", "REVOKED"] : [group];
    try {
      const pages = await Promise.all(statuses.filter(status => !more || nextCursors[status]).map(async status => ({ status, page: await api.list({ limit: 20, status, ...(mode ? { mode } : {}), ...(search ? { text: search } : {}), ...(more && nextCursors[status] ? { cursor: nextCursors[status] } : {}) }, contextId) })));
      if (!current() || listEpoch.current !== epoch) return;
      const newCursors: Partial<Record<LearningReviewStatus, string>> = {};
      for (const { status, page } of pages) if (page.nextCursor) newCursors[status] = page.nextCursor;
      setCursors(newCursors);
      setItems(previous => [...new Map([...(more ? previous : []), ...pages.flatMap(({ page }) => page.items)].map(item => [item.id, item])).values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    } catch (failure) { if (current() && listEpoch.current === epoch) showFailure(failure); }
    finally { if (current() && listEpoch.current === epoch) setLoading(false); }
  }, [api, contextId, current, group, mode, search, showFailure]);
  useEffect(() => { clearDetail(); setSuccess(false); void loadList(false); }, [loadList, clearDetail]);
  const loadDetail = async (id: string, version?: number) => {
    clearDetail(); const epoch = ++detailEpoch.current; setDetailLoading(true); setError(null); setSuccess(false); setConflicted(false);
    try {
      const value = await api.get(id, version, contextId);
      if (!current() || detailEpoch.current !== epoch) return;
      setDetail({ contextId, value }); setBody(value.revision.body); setPurpose(value.revision.purpose);
      setValidFrom(localDate(value.revision.validFrom)); setValidUntil(localDate(value.revision.validUntil));
      // Every new decision requires an explicit reviewer assessment, including UNASSESSED.
      setAssessment(""); setReason("");
    } catch (failure) { if (current() && detailEpoch.current === epoch) showFailure(failure); }
    finally { if (current() && detailEpoch.current === epoch) setDetailLoading(false); }
  };
  const value = detail?.contextId === contextId && isCurrentTenantContext(contextId) ? detail.value : null;
  const isCurrentRevision = value?.revision.version === value?.review.version;
  const canReview = Boolean(value && isCurrentRevision && (value.review.status === "PENDING" || value.review.status === "CONFIRMED"));
  const mutate = async (action: "CONFIRM" | "ADJUST" | "REJECT" | "REVOKE") => {
    if (!value || !current() || !reason.trim() || busy || !canReview || (action !== "REVOKE" && !assessment)) return;
    const epoch = ++mutationEpoch.current;
    const reviewId = value.review.id;
    const input = action === "REVOKE" ? { expectedVersion: value.review.version, reason: reason.trim() } : {
      expectedVersion: value.review.version, decision: action, reason: reason.trim(), caseAssessment: assessment as LearningCaseAssessment,
      ...(action === "ADJUST" ? { body: body.trim(), purpose, validFrom: validFrom ? new Date(validFrom).toISOString() : null, validUntil: validUntil ? new Date(validUntil).toISOString() : null } : {})
    };
    const signature = JSON.stringify([reviewId, action, input]);
    if (pendingMutation.current?.signature !== signature) pendingMutation.current = { signature, key: `learning-${crypto.randomUUID()}` };
    const key = pendingMutation.current.key;
    setBusy(true); setError(null); setSuccess(false);
    try {
      const result = action === "REVOKE" ? await api.revoke(reviewId, input, key, contextId) : await api.decide(reviewId, input as LearningReviewDecisionInput, key, contextId);
      if (!current() || mutationEpoch.current !== epoch) return;
      pendingMutation.current = null; setDetail({ contextId, value: result }); setEditing(false);
      setBody(result.revision.body); setPurpose(result.revision.purpose); setReason(""); setAssessment(""); setSuccess(true);
      await loadList(false);
    } catch (failure) { if (current() && mutationEpoch.current === epoch) showFailure(failure); }
    finally { if (current() && mutationEpoch.current === epoch) setBusy(false); }
  };

  return <section className="widget-card learning-review-panel" aria-label={t("learning.title")}>
    <WidgetHeader title={t("learning.title")} onClose={onDismiss} />
    <p className="widget-card__body-text">{t("learning.scope")}</p>
    <nav className="widget-card__chips" aria-label={t("learning.states")}>
      {(["PENDING", "CONFIRMED", "DISCARDED"] as const).map(state => <button type="button" className="widget-card__chip" aria-pressed={group === state} disabled={busy} key={state} onClick={() => setGroup(state)}>{t(`learning.${state}`)}</button>)}
    </nav>
    <div className="learning-review-panel__filters">
      <label>{t("learning.search")}<input value={text} maxLength={160} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      <label>{t("learning.mode")}<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}><option value="">{t("learning.allModes")}</option><option value="SIMULATION">SIMULATION</option><option value="EXECUTION">EXECUTION</option></select></label>
      <button type="button" className="widget-card__chip" disabled={loading || busy} onClick={() => void loadList(false)}>{t("learning.refresh")}</button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {success ? <p role="status">{t("learning.saved")}</p> : null}
    {loading ? <p role="status">{t("learning.loading")}</p> : null}
    {!loading && items.length === 0 ? <p>{t("learning.empty")}</p> : null}
    <ul className="learning-review-panel__list">{items.map(item => <li key={item.id}><button type="button" disabled={busy} aria-pressed={value?.review.id === item.id} onClick={() => void loadDetail(item.id)}><span>{item.bodyPreview}</span><small>{item.agentId} · {item.mode} · {t(`learning.${item.status}`)} · v{item.version}</small></button></li>)}</ul>
    {Object.keys(cursors).length ? <button type="button" className="widget-card__chip" disabled={loading || busy} onClick={() => void loadList(true, cursors)}>{t("learning.more")}</button> : null}
    {detailLoading ? <p role="status">{t("learning.loading")}</p> : null}
    {value ? <article className="learning-review-panel__detail">
      <h3>{t(`learning.${value.review.status}`)} · {value.review.mode} · v{value.revision.version}</h3>
      <p>{value.review.agentId} · {t(`learning.${value.revision.purpose}`)}</p>
      <p>{t("learning.caseExample")}</p>
      <details><summary>{t("learning.original")}</summary><pre>{value.originalFeedback.decisionReason}</pre><p>{value.originalFeedback.actorUserId} · {value.originalFeedback.decidedAt} · {t(value.originalFeedback.approved ? "learning.businessApproved" : "learning.businessDeclined")}</p><small>{value.originalFeedback.eventId} · {value.originalFeedback.runId} · CAPTURED</small></details>
      <details><summary>{t("learning.reviewRecord")}</summary><p>{value.revision.reviewerUserId ?? "—"} · {value.revision.createdAt}</p><p>{value.revision.caseAssessment ? t(`learning.${value.revision.caseAssessment}`) : t("learning.UNASSESSED")}</p><pre>{value.revision.reviewReason ?? "—"}</pre><p>{value.revision.validFrom ?? "—"} — {value.revision.validUntil ?? "—"}</p><small>{value.revision.id} · {value.revision.bodySha256}</small></details>
      <div className="widget-card__chips">
        {value.revision.version > 1 ? <button type="button" className="widget-card__chip" disabled={busy} onClick={() => void loadDetail(value.review.id, value.revision.version - 1)}>{t("learning.previous")}</button> : null}
        {!isCurrentRevision || conflicted ? <button type="button" className="widget-card__chip" onClick={() => void loadDetail(value.review.id)}>{t("learning.current")}</button> : null}
      </div>
      {editing ? <div className="learning-review-panel__form">
        <label>{t("learning.body")}<textarea value={body} maxLength={65536} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
        <label>{t("learning.purpose")}<select value={purpose} disabled={busy} onChange={event => setPurpose(event.target.value as LearningReviewPurpose)}><option value="TASK">{t("learning.TASK")}</option><option value="COMPANY">{t("learning.COMPANY")}</option></select></label>
        <label>{t("learning.validFrom")}<input type="datetime-local" value={validFrom} disabled={busy} onChange={event => setValidFrom(event.target.value)} /></label>
        <label>{t("learning.validUntil")}<input type="datetime-local" value={validUntil} disabled={busy} onChange={event => setValidUntil(event.target.value)} /></label>
      </div> : <pre>{value.revision.body}</pre>}
      {canReview ? <div className="learning-review-panel__form">
        <label>{t("learning.assessment")}<select value={assessment} disabled={busy} onChange={event => setAssessment(event.target.value as LearningCaseAssessment)}><option value="">{t("learning.chooseAssessment")}</option>{(["POSITIVE", "NEGATIVE", "CORRECTION", "UNASSESSED"] as const).map(option => <option key={option} value={option}>{t(`learning.${option}`)}</option>)}</select></label>
        <label>{t("learning.reason")}<textarea value={reason} maxLength={4096} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <div className="widget-card__chips">
          {!editing ? <button type="button" className="widget-card__chip" disabled={busy} onClick={() => setEditing(true)}>{t("learning.adjust")}</button> : <>
            <button type="button" className="widget-card__chip" disabled={busy || !reason.trim() || !assessment || !body.trim() || Boolean(validFrom && validUntil && validUntil <= validFrom)} onClick={() => void mutate("ADJUST")}>{t("learning.saveConfirm")}</button>
            <button type="button" className="widget-card__chip" disabled={busy} onClick={() => { setBody(value.revision.body); setPurpose(value.revision.purpose); setValidFrom(localDate(value.revision.validFrom)); setValidUntil(localDate(value.revision.validUntil)); setEditing(false); }}>{t("learning.cancel")}</button>
          </>}
          {value.review.status === "PENDING" && !editing ? <>
            <button type="button" className="widget-card__chip" disabled={busy || !reason.trim() || !assessment} onClick={() => void mutate("CONFIRM")}>{t("learning.confirm")}</button>
            <button type="button" className="widget-card__chip" disabled={busy || !reason.trim() || !assessment} onClick={() => void mutate("REJECT")}>{t("learning.reject")}</button>
          </> : null}
          {value.review.status === "CONFIRMED" && !editing ? <button type="button" className="widget-card__chip" disabled={busy || !reason.trim()} onClick={() => void mutate("REVOKE")}>{t("learning.revoke")}</button> : null}
        </div>
      </div> : null}
    </article> : null}
  </section>;
}

/** A new immutable tenant context synchronously remounts all private view state. */
export function LearningReviewPanel(props: { contextId: string; onDismiss?: () => void; api?: LearningReviewsApi }) {
  return <LearningReviewWorkspace key={props.contextId} {...props} />;
}
