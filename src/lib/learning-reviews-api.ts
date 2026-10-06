import { decideLearningReview, getLearningReview, listLearningReviews, revokeLearningReview } from "./tauri";
export const learningReviewsApi = {
  list: listLearningReviews,
  get: getLearningReview,
  decide: decideLearningReview,
  revoke: revokeLearningReview
};
export type LearningReviewsApi = typeof learningReviewsApi;
