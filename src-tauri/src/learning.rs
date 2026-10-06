//! Source-bound review transport. These commands never call business HITL routes.
use super::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LearningReviewListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    status: Option<LearningReviewStatus>,
    agent_id: Option<String>,
    mode: Option<LearningReviewMode>,
    purpose: Option<LearningReviewPurpose>,
    text: Option<String>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum LearningReviewStatus {
    Pending,
    Confirmed,
    Rejected,
    Revoked,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum LearningReviewMode {
    Simulation,
    Execution,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum LearningReviewPurpose {
    Task,
    Company,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum LearningReviewDecision {
    Confirm,
    Adjust,
    Reject,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(super) enum LearningCaseAssessment {
    Positive,
    Negative,
    Correction,
    Unassessed,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LearningReviewDecisionInput {
    expected_version: u32,
    decision: LearningReviewDecision,
    reason: String,
    case_assessment: LearningCaseAssessment,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    purpose: Option<LearningReviewPurpose>,
    #[serde(
        default,
        deserialize_with = "nullable_date",
        skip_serializing_if = "Option::is_none"
    )]
    valid_from: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "nullable_date",
        skip_serializing_if = "Option::is_none"
    )]
    valid_until: Option<Option<String>>,
}

// Omission preserves the date; explicit null clears it through the API contract.
fn nullable_date<'de, D: serde::Deserializer<'de>>(
    value: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(value).map(Some)
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RevokeLearningReviewInput {
    expected_version: u32,
    reason: String,
}

fn list_path(query: LearningReviewListQuery) -> Result<String, String> {
    let mut fields: Vec<(String, String)> = Vec::new();
    if let Some(limit) = query.limit {
        if !(1..=50).contains(&limit) {
            return Err("AUTH_INVALID_REQUEST".into());
        }
        fields.push(("limit".into(), limit.to_string()));
    }
    for (name, value) in [
        ("cursor", query.cursor),
        ("agentId", query.agent_id),
        ("text", query.text),
    ] {
        if let Some(value) = value {
            fields.push((name.into(), value));
        }
    }
    for (name, value) in [
        (
            "status",
            query.status.map(|v| serde_json::to_value(v).unwrap()),
        ),
        ("mode", query.mode.map(|v| serde_json::to_value(v).unwrap())),
        (
            "purpose",
            query.purpose.map(|v| serde_json::to_value(v).unwrap()),
        ),
    ] {
        if let Some(Value::String(value)) = value {
            fields.push((name.into(), value));
        }
    }
    let pairs: Vec<(&str, &str)> = fields
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    desktop_avatar_resource_path(&["v1", "learning", "reviews"], &pairs)
}
fn resource_path(id: &str, action: Option<&str>, version: Option<u32>) -> Result<String, String> {
    if id.trim().is_empty() || id.len() > 160 || version == Some(0) {
        return Err("AUTH_INVALID_REQUEST".into());
    }
    let mut segments = vec!["v1", "learning", "reviews", id];
    if let Some(action) = action {
        segments.push(action);
    }
    let version = version.map(|v| v.to_string());
    let query = version
        .as_deref()
        .map(|v| vec![("version", v)])
        .unwrap_or_default();
    desktop_avatar_resource_path(&segments, &query)
}
fn review_error(error: agent_studio::AgentStudioApiError) -> String {
    json!({"status": error.status, "code": error.code, "message": error.message, "retryAfter": error.retry_after}).to_string()
}

async fn read_review(state: &AppState, path: &str, context: &str) -> Result<Value, String> {
    let broker = agent_studio_broker(state).map_err(|e| e.to_string())?;
    let execution = broker
        .require_execution_context(context)
        .await
        .map_err(|e| e.to_string())?;
    let result = execution.api.get_json::<Value>(path).await;
    if !broker
        .is_current(&execution.session.context_id, execution.session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".into());
    }
    result.map_err(review_error)
}
async fn write_review<T: Serialize>(
    state: &AppState,
    path: &str,
    input: &T,
    key: &str,
    context: &str,
) -> Result<Value, String> {
    if key.is_empty()
        || key.len() > 160
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
    {
        return Err("AUTH_INVALID_REQUEST".into());
    }
    let broker = agent_studio_broker(state).map_err(|e| e.to_string())?;
    let execution = broker
        .require_execution_context(context)
        .await
        .map_err(|e| e.to_string())?;
    let result = execution
        .api
        .post_json_with_idempotency::<_, Value>(path, input, key)
        .await;
    if !broker
        .is_current(&execution.session.context_id, execution.session.local_epoch)
        .await
    {
        return Err("DESKTOP_SESSION_CHANGED".into());
    }
    result.map_err(review_error)
}
#[tauri::command]
pub(super) async fn learning_reviews_list(
    state: State<'_, AppState>,
    query: LearningReviewListQuery,
    expected_context_id: String,
) -> Result<Value, String> {
    read_review(state.inner(), &list_path(query)?, &expected_context_id).await
}
#[tauri::command]
pub(super) async fn learning_review_get(
    state: State<'_, AppState>,
    review_id: String,
    version: Option<u32>,
    expected_context_id: String,
) -> Result<Value, String> {
    read_review(
        state.inner(),
        &resource_path(&review_id, None, version)?,
        &expected_context_id,
    )
    .await
}
#[tauri::command]
pub(super) async fn learning_review_decide(
    state: State<'_, AppState>,
    review_id: String,
    input: LearningReviewDecisionInput,
    idempotency_key: String,
    expected_context_id: String,
) -> Result<Value, String> {
    write_review(
        state.inner(),
        &resource_path(&review_id, Some("decision"), None)?,
        &input,
        &idempotency_key,
        &expected_context_id,
    )
    .await
}
#[tauri::command]
pub(super) async fn learning_review_revoke(
    state: State<'_, AppState>,
    review_id: String,
    input: RevokeLearningReviewInput,
    idempotency_key: String,
    expected_context_id: String,
) -> Result<Value, String> {
    write_review(
        state.inner(),
        &resource_path(&review_id, Some("revoke"), None)?,
        &input,
        &idempotency_key,
        &expected_context_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_paths_encode_identifiers_and_filters_without_business_routes() {
        let path = resource_path("review/a?b", Some("decision"), None).unwrap();
        assert_eq!(path, "/v1/learning/reviews/review%2Fa%3Fb/decision");
        let query: LearningReviewListQuery =
            serde_json::from_value(json!({"status":"REVOKED","text":"case & company","limit":20}))
                .unwrap();
        assert_eq!(
            list_path(query).unwrap(),
            "/v1/learning/reviews?limit=20&text=case+%26+company&status=REVOKED"
        );
        assert!(resource_path("", None, None).is_err());
        assert!(resource_path("review", None, Some(0)).is_err());
    }
    #[test]
    fn mutation_requires_explicit_assessment_and_rejects_owner_override() {
        let input = json!({"expectedVersion":1,"decision":"CONFIRM","reason":"case checked","caseAssessment":"UNASSESSED"});
        assert!(serde_json::from_value::<LearningReviewDecisionInput>(input.clone()).is_ok());
        let mut missing = input.clone();
        missing.as_object_mut().unwrap().remove("caseAssessment");
        assert!(serde_json::from_value::<LearningReviewDecisionInput>(missing).is_err());
        let mut changed = input;
        changed["ownerUserId"] = json!("other");
        assert!(serde_json::from_value::<LearningReviewDecisionInput>(changed).is_err());
    }
    #[test]
    fn adjustment_preserves_omitted_dates_and_transmits_explicit_clear() {
        let input = json!({"expectedVersion":2,"decision":"ADJUST","reason":"checked","caseAssessment":"CORRECTION","body":"case","purpose":"TASK","validUntil":null});
        let parsed: LearningReviewDecisionInput = serde_json::from_value(input).unwrap();
        let sent = serde_json::to_value(parsed).unwrap();
        assert!(sent.get("validFrom").is_none());
        assert_eq!(sent.get("validUntil"), Some(&serde_json::Value::Null));
    }
    #[test]
    fn native_error_retains_access_loss_and_conflict_status() {
        for status in [401, 403, 404, 409] {
            let error = agent_studio::AgentStudioApiError {
                status: Some(status),
                code: Some("LEARNING_REVIEW".into()),
                message: "Denied".into(),
                retry_after: None,
            };
            let sent: Value = serde_json::from_str(&review_error(error)).unwrap();
            assert_eq!(sent["status"], status);
        }
    }
}
