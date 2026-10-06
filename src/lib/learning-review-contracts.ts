/** Standalone client projection of agent-studio-contracts/src/learningReviews.ts. */
export type LearningReviewPurpose = "TASK" | "COMPANY";
export type LearningReviewStatus = "PENDING" | "CONFIRMED" | "REJECTED" | "REVOKED";
export type LearningCaseAssessment = "POSITIVE" | "NEGATIVE" | "CORRECTION" | "UNASSESSED";
export interface LearningReviewHead {
  id: string;
  version: number;
  currentRevisionId: string;
  status: LearningReviewStatus;
  purpose: LearningReviewPurpose;
  source: "HITL_HUMAN";
  access: "SOURCE_OWNER";
  tenantId: string;
  ownerUserId: string;
  agentId: string;
  mode: "SIMULATION" | "EXECUTION";
  sourceEventId: string;
  sourceRunId: string;
  sourceProposalId: string;
  createdAt: string;
  updatedAt: string;
}
export interface LearningReviewRevision {
  id: string;
  reviewId: string;
  version: number;
  predecessorId?: string;
  status: LearningReviewStatus;
  purpose: LearningReviewPurpose;
  body: string;
  bodySha256: string;
  caseAssessment?: LearningCaseAssessment;
  reviewerUserId?: string;
  reviewReason?: string;
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
}
export interface LearningReviewSource {
  eventId: string;
  runId: string;
  proposalId: string;
  approved: boolean;
  decisionReason: string;
  actorUserId: string;
  decidedAt: string;
  scope: "single" | "bulk_selection" | "group";
  auditSource: "api" | "ui";
  learningCaptureStatus: "CAPTURED";
}
export interface LearningReviewDetail {
  review: LearningReviewHead;
  revision: LearningReviewRevision;
  originalFeedback: LearningReviewSource;
}
export type LearningReviewSummary = Pick<LearningReviewHead,
  "id" | "version" | "status" | "purpose" | "agentId" | "mode" | "sourceEventId" |
  "sourceRunId" | "sourceProposalId" | "createdAt" | "updatedAt"> & { bodyPreview: string };
export interface LearningReviewListQuery {
  limit?: number;
  cursor?: string;
  status?: LearningReviewStatus;
  agentId?: string;
  mode?: "SIMULATION" | "EXECUTION";
  purpose?: LearningReviewPurpose;
  text?: string;
}
export interface LearningReviewListResponse { items: LearningReviewSummary[]; nextCursor?: string }
export interface LearningReviewDecisionInput {
  expectedVersion: number;
  decision: "CONFIRM" | "ADJUST" | "REJECT";
  reason: string;
  caseAssessment: LearningCaseAssessment;
  body?: string;
  purpose?: LearningReviewPurpose;
  validFrom?: string | null;
  validUntil?: string | null;
}
export interface RevokeLearningReviewInput { expectedVersion: number; reason: string }
