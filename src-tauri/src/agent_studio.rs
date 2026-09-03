use std::{
    fmt,
    future::Future,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};

use reqwest::{
    cookie::{CookieStore, Jar},
    header::{HeaderName, HeaderValue, ACCEPT, CONTENT_TYPE, ORIGIN},
    redirect::Policy,
    Client, Method, Response, Url,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::sync::Mutex;

const DEFAULT_CSRF_COOKIE: &str = "agent_studio_csrf";
const PREAUTHENTICATED_STATUS: &str = "PREAUTHENTICATED";
const X_CSRF_TOKEN: HeaderName = HeaderName::from_static("x-csrf-token");
const X_IDEMPOTENCY_KEY: HeaderName = HeaderName::from_static("x-idempotency-key");

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStudioApiError {
    pub status: Option<u16>,
    pub code: Option<String>,
    pub message: String,
    pub retry_after: Option<u64>,
}

impl AgentStudioApiError {
    pub fn local(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status: None,
            code: Some(code.into()),
            message: message.into(),
            retry_after: None,
        }
    }

    fn invalid_response(message: impl Into<String>) -> Self {
        Self::local("AUTH_OCWS_INVALID_RESPONSE", message)
    }

    fn network() -> Self {
        Self::local(
            "AUTH_OCWS_UNAVAILABLE",
            "Agent Studio is currently unavailable. Try again manually.",
        )
    }
}

impl fmt::Display for AgentStudioApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.requires_reauthentication() {
            write!(
                formatter,
                "{}: {}",
                self.code.as_deref().unwrap_or("AUTH_SESSION_INVALID"),
                self.message
            )
        } else {
            write!(formatter, "{}", self.message)
        }
    }
}

impl AgentStudioApiError {
    pub fn requires_reauthentication(&self) -> bool {
        self.status == Some(401)
            || matches!(
                self.code.as_deref(),
                Some("AUTH_SESSION_REQUIRED" | "AUTH_SESSION_INVALID")
            )
    }
}

impl std::error::Error for AgentStudioApiError {}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthPreauthenticateResult {
    pub status: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthCompanySummary {
    pub company_id: String,
    pub company_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthBranchSummary {
    pub branch_id: String,
    pub branch_name: String,
    pub company_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthCollectionResponse<T> {
    pub items: Vec<T>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub global_authorities: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TenantSummary {
    pub tenant_id: String,
    pub company_id: String,
    pub company_name: String,
    pub branch_id: String,
    pub branch_name: String,
    pub can_administer: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthSessionContext {
    pub session_id: String,
    pub user: AuthUser,
    pub selected_tenant: TenantSummary,
    pub accessible_tenants: Vec<TenantSummary>,
    pub administrable_tenant_ids: Vec<String>,
    pub expires_at: String,
}

impl AuthSessionContext {
    pub fn validate(mut self) -> Result<Self, AgentStudioApiError> {
        normalize_non_empty(&mut self.session_id)?;
        normalize_non_empty(&mut self.user.id)?;
        normalize_non_empty(&mut self.user.username)?;
        if let Some(display_name) = &mut self.user.display_name {
            normalize_non_empty(display_name)?;
        }
        for authority in &mut self.user.global_authorities {
            normalize_non_empty(authority)?;
        }
        normalize_tenant(&mut self.selected_tenant)?;
        for tenant in &mut self.accessible_tenants {
            normalize_tenant(tenant)?;
        }
        for tenant_id in &mut self.administrable_tenant_ids {
            normalize_non_empty(tenant_id)?;
        }
        self.expires_at = canonical_datetime(&self.expires_at)?;
        let non_empty = [
            self.session_id.as_str(),
            self.user.id.as_str(),
            self.user.username.as_str(),
            self.selected_tenant.tenant_id.as_str(),
            self.selected_tenant.company_id.as_str(),
            self.selected_tenant.branch_id.as_str(),
            self.expires_at.as_str(),
        ];
        let valid_user = self
            .user
            .display_name
            .as_ref()
            .is_none_or(|value| !value.trim().is_empty())
            && self
                .user
                .global_authorities
                .iter()
                .all(|value| !value.trim().is_empty());
        let valid_tenants = self.accessible_tenants.iter().all(|tenant| {
            valid_ocws_id(&tenant.company_id)
                && valid_ocws_id(&tenant.branch_id)
                && !tenant.tenant_id.trim().is_empty()
                && !tenant.company_name.trim().is_empty()
                && !tenant.branch_name.trim().is_empty()
                && tenant.can_administer
        });
        if non_empty.iter().any(|value| value.trim().is_empty())
            || self.accessible_tenants.is_empty()
            || !valid_user
            || !valid_tenants
            || !valid_ocws_id(&self.selected_tenant.company_id)
            || !valid_ocws_id(&self.selected_tenant.branch_id)
            || !self.selected_tenant.can_administer
        {
            return Err(AgentStudioApiError::invalid_response(
                "Agent Studio returned an invalid session context.",
            ));
        }
        let selected_is_offered = self
            .accessible_tenants
            .iter()
            .any(|tenant| tenant.tenant_id == self.selected_tenant.tenant_id);
        let expected_admin_ids = self
            .accessible_tenants
            .iter()
            .map(|tenant| tenant.tenant_id.as_str())
            .collect::<Vec<_>>();
        let admin_ids_match = self
            .administrable_tenant_ids
            .iter()
            .map(String::as_str)
            .eq(expected_admin_ids);
        if !selected_is_offered || !admin_ids_match {
            return Err(AgentStudioApiError::invalid_response(
                "Agent Studio returned an inconsistent session tenant projection.",
            ));
        }
        Ok(self)
    }
}

fn valid_ocws_id(value: &str) -> bool {
    canonical_ocws_id(value).is_ok_and(|canonical| canonical == value)
}

fn canonical_ocws_id(value: &str) -> Result<String, AgentStudioApiError> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let normalized = value.trim();
    if normalized.is_empty() || !normalized.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AgentStudioApiError::invalid_response(
            "Agent Studio returned an invalid OCWS identifier.",
        ));
    }
    let number = normalized.parse::<u64>().map_err(|_| {
        AgentStudioApiError::invalid_response("Agent Studio returned an invalid OCWS identifier.")
    })?;
    if number > MAX_SAFE_INTEGER {
        return Err(AgentStudioApiError::invalid_response(
            "Agent Studio returned an unsafe OCWS identifier.",
        ));
    }
    Ok(number.to_string())
}

fn normalize_non_empty(value: &mut String) -> Result<(), AgentStudioApiError> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(AgentStudioApiError::invalid_response(
            "Agent Studio returned an invalid response.",
        ));
    }
    *value = normalized.to_string();
    Ok(())
}

fn normalize_tenant(tenant: &mut TenantSummary) -> Result<(), AgentStudioApiError> {
    normalize_non_empty(&mut tenant.tenant_id)?;
    tenant.company_id = canonical_ocws_id(&tenant.company_id)?;
    normalize_non_empty(&mut tenant.company_name)?;
    tenant.branch_id = canonical_ocws_id(&tenant.branch_id)?;
    normalize_non_empty(&mut tenant.branch_name)?;
    if !tenant.can_administer {
        return Err(AgentStudioApiError::invalid_response(
            "Agent Studio returned a non-administrable tenant.",
        ));
    }
    Ok(())
}

fn canonical_datetime(value: &str) -> Result<String, AgentStudioApiError> {
    let normalized = value.trim();
    OffsetDateTime::parse(normalized, &Rfc3339).map_err(|_| {
        AgentStudioApiError::invalid_response("Agent Studio returned an invalid datetime.")
    })?;
    Ok(normalized.to_string())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthLogoutResponse {
    pub success: bool,
}

#[derive(Clone)]
struct Transport {
    client: Client,
    jar: Arc<Jar>,
}

#[derive(Clone)]
pub struct AgentStudioApiClient {
    base_url: Url,
    origin: String,
    csrf_cookie_name: String,
    transport: Arc<Mutex<Transport>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAvatarTenantSession {
    pub context_id: String,
    pub public_session: AuthSessionContext,
    pub local_epoch: u64,
}

#[derive(Clone)]
pub struct AgentStudioSessionBroker {
    api: AgentStudioApiClient,
    active: Arc<Mutex<Option<DesktopAvatarTenantSession>>>,
    pending_password: Arc<Mutex<Option<String>>>,
    login_flow_expires_at: Arc<Mutex<Option<OffsetDateTime>>>,
    transition: Arc<Mutex<()>>,
    epoch: Arc<AtomicU64>,
}

impl AgentStudioSessionBroker {
    pub fn new(api: AgentStudioApiClient) -> Self {
        Self {
            api,
            active: Arc::new(Mutex::new(None)),
            pending_password: Arc::new(Mutex::new(None)),
            login_flow_expires_at: Arc::new(Mutex::new(None)),
            transition: Arc::new(Mutex::new(())),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    pub async fn preauthenticate_with_invalidation<F, Fut>(
        &self,
        username: &str,
        password: &str,
        after_invalidation: F,
    ) -> Result<AuthPreauthenticateResult, AgentStudioApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ()>,
    {
        let _transition = self.transition.lock().await;
        if self.active.lock().await.is_some() {
            return Err(AgentStudioApiError::local(
                "AUTH_INVALID_REQUEST",
                "Log out before starting a new Agent Studio login.",
            ));
        }
        self.invalidate_unlocked().await?;
        after_invalidation().await;
        let result = match self.api.preauthenticate(username, password).await {
            Ok(result) => result,
            Err(error) => {
                self.invalidate_unlocked().await?;
                return Err(error);
            }
        };
        let expires_at = match OffsetDateTime::parse(result.expires_at.trim(), &Rfc3339) {
            Ok(expires_at) => expires_at,
            Err(_) => {
                self.invalidate_unlocked().await?;
                return Err(AgentStudioApiError::invalid_response(
                    "Agent Studio returned an invalid login-flow expiry.",
                ));
            }
        };
        if expires_at <= OffsetDateTime::now_utc() {
            self.invalidate_unlocked().await?;
            return Err(AgentStudioApiError::local(
                "AUTH_LOGIN_FLOW_INVALID",
                "The Agent Studio login flow has expired.",
            ));
        }
        *self.pending_password.lock().await = Some(password.to_string());
        *self.login_flow_expires_at.lock().await = Some(expires_at);
        let broker = self.clone();
        let login_epoch = self.epoch.load(Ordering::SeqCst);
        let delay = (expires_at - OffsetDateTime::now_utc())
            .try_into()
            .unwrap_or_default();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _transition = broker.transition.lock().await;
            if broker.epoch.load(Ordering::SeqCst) == login_epoch
                && *broker.login_flow_expires_at.lock().await == Some(expires_at)
            {
                let _ = broker.invalidate_unlocked().await;
            }
        });
        Ok(result)
    }

    pub async fn companies(&self) -> Result<Vec<AuthCompanySummary>, AgentStudioApiError> {
        let _transition = self.transition.lock().await;
        self.ensure_login_flow_current_unlocked().await?;
        match self.api.companies().await {
            Err(error) if error.code.as_deref() == Some("AUTH_LOGIN_FLOW_INVALID") => {
                self.invalidate_unlocked().await?;
                Err(error)
            }
            result => result,
        }
    }

    pub async fn branches(
        &self,
        company_id: &str,
    ) -> Result<Vec<AuthBranchSummary>, AgentStudioApiError> {
        let _transition = self.transition.lock().await;
        self.ensure_login_flow_current_unlocked().await?;
        match self.api.branches(company_id).await {
            Err(error) if error.code.as_deref() == Some("AUTH_LOGIN_FLOW_INVALID") => {
                self.invalidate_unlocked().await?;
                Err(error)
            }
            result => result,
        }
    }

    pub async fn complete(
        &self,
        company_id: &str,
        branch_id: &str,
    ) -> Result<DesktopAvatarTenantSession, AgentStudioApiError> {
        let _transition = self.transition.lock().await;
        self.ensure_login_flow_current_unlocked().await?;
        let mut password = self.pending_password.lock().await.take().ok_or_else(|| {
            AgentStudioApiError::local(
                "AUTH_LOGIN_FLOW_INVALID",
                "The Agent Studio login flow must be started again.",
            )
        })?;
        let completed_result = self.api.complete(company_id, branch_id, &password).await;
        password.clear();
        let completed = match completed_result {
            Ok(completed) => completed,
            Err(error) => {
                self.invalidate_unlocked().await?;
                return Err(error);
            }
        };
        let confirmed = match self.api.session().await {
            Ok(confirmed) => confirmed,
            Err(error) => {
                self.invalidate_unlocked().await?;
                return Err(error);
            }
        };
        if completed.session_id != confirmed.session_id
            || completed.selected_tenant.tenant_id != confirmed.selected_tenant.tenant_id
        {
            self.invalidate_unlocked().await?;
            return Err(AgentStudioApiError::invalid_response(
                "Agent Studio returned inconsistent session confirmation.",
            ));
        }
        self.activate(confirmed).await
    }

    pub async fn session_with_invalidation<F, Fut>(
        &self,
        after_invalidation: F,
    ) -> Result<DesktopAvatarTenantSession, AgentStudioApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ()>,
    {
        let _transition = self.transition.lock().await;
        let confirmed = match self.api.session().await {
            Ok(confirmed) => confirmed,
            Err(error) => {
                if error.requires_reauthentication() {
                    self.invalidate_state().await;
                    after_invalidation().await;
                    self.api.reset_cookies().await?;
                }
                return Err(error);
            }
        };
        let current = self.active.lock().await.clone();
        if let Some(current) = current {
            if current.public_session.session_id != confirmed.session_id
                || current.public_session.selected_tenant.tenant_id
                    != confirmed.selected_tenant.tenant_id
            {
                self.invalidate_state().await;
                after_invalidation().await;
                self.api.reset_cookies().await?;
                return Err(AgentStudioApiError::local(
                    "DESKTOP_SESSION_CHANGED",
                    "The Agent Studio session changed.",
                ));
            }
            return Ok(current);
        }
        self.activate(confirmed).await
    }

    pub async fn require_current(
        &self,
        expected_context_id: &str,
    ) -> Result<DesktopAvatarTenantSession, AgentStudioApiError> {
        let expected = expected_context_id.trim();
        if expected.is_empty() {
            return Err(AgentStudioApiError::local(
                "DESKTOP_SESSION_CHANGED",
                "An active Agent Studio session is required.",
            ));
        }
        let current = self.active.lock().await.clone().ok_or_else(|| {
            AgentStudioApiError::local(
                "DESKTOP_SESSION_CHANGED",
                "An active Agent Studio session is required.",
            )
        })?;
        if current.context_id != expected
            || current.local_epoch != self.epoch.load(Ordering::SeqCst)
        {
            return Err(AgentStudioApiError::local(
                "DESKTOP_SESSION_CHANGED",
                "The Agent Studio session changed.",
            ));
        }
        Ok(current)
    }

    pub async fn require_execution_context(
        &self,
        expected_context_id: &str,
    ) -> Result<TenantExecutionContext, AgentStudioApiError> {
        let _transition = self.transition.lock().await;
        let session = self.require_current(expected_context_id).await?;
        let api = self.api.snapshot().await;
        if !self
            .is_current(&session.context_id, session.local_epoch)
            .await
        {
            return Err(AgentStudioApiError::local(
                "DESKTOP_SESSION_CHANGED",
                "The Agent Studio session changed.",
            ));
        }
        Ok(TenantExecutionContext { session, api })
    }

    pub async fn run_if_current<F, Fut, T>(
        &self,
        expected_context_id: &str,
        action: F,
    ) -> Result<T, AgentStudioApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, AgentStudioApiError>>,
    {
        let _transition = self.transition.lock().await;
        self.require_current(expected_context_id).await?;
        action().await
    }

    pub async fn is_current(&self, context_id: &str, local_epoch: u64) -> bool {
        let current = self.active.lock().await;
        current.as_ref().is_some_and(|session| {
            session.context_id == context_id
                && session.local_epoch == local_epoch
                && self.epoch.load(Ordering::SeqCst) == local_epoch
        })
    }

    #[cfg(test)]
    pub async fn invalidate(&self) -> Result<(), AgentStudioApiError> {
        let _transition = self.transition.lock().await;
        self.invalidate_unlocked().await
    }

    async fn invalidate_state(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.active.lock().await.take();
        if let Some(mut password) = self.pending_password.lock().await.take() {
            password.clear();
        }
        self.login_flow_expires_at.lock().await.take();
    }

    async fn ensure_login_flow_current_unlocked(&self) -> Result<(), AgentStudioApiError> {
        let expires_at = *self.login_flow_expires_at.lock().await;
        if expires_at.is_some_and(|value| value > OffsetDateTime::now_utc())
            && self.pending_password.lock().await.is_some()
        {
            return Ok(());
        }
        self.invalidate_unlocked().await?;
        Err(AgentStudioApiError::local(
            "AUTH_LOGIN_FLOW_INVALID",
            "The Agent Studio login flow has expired.",
        ))
    }

    async fn invalidate_unlocked(&self) -> Result<(), AgentStudioApiError> {
        self.invalidate_state().await;
        self.api.reset_cookies().await
    }

    pub async fn logout_with_invalidation<F, Fut>(
        &self,
        after_invalidation: F,
    ) -> Result<AuthLogoutResponse, AgentStudioApiError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ()>,
    {
        let _transition = self.transition.lock().await;
        self.invalidate_state().await;
        after_invalidation().await;
        let remote = self.api.logout().await;
        let local = self.api.reset_cookies().await;
        match (remote, local) {
            (Ok(response), Ok(())) => Ok(response),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    async fn activate(
        &self,
        public_session: AuthSessionContext,
    ) -> Result<DesktopAvatarTenantSession, AgentStudioApiError> {
        let public_session = public_session.validate()?;
        let local_epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let session = DesktopAvatarTenantSession {
            context_id: uuid::Uuid::new_v4().to_string(),
            public_session,
            local_epoch,
        };
        *self.active.lock().await = Some(session.clone());
        Ok(session)
    }
}

#[derive(Clone)]
pub struct TenantExecutionContext {
    pub session: DesktopAvatarTenantSession,
    pub api: AgentStudioApiClient,
}

impl AgentStudioApiClient {
    pub fn new(
        base_url: &str,
        csrf_cookie_name: Option<&str>,
    ) -> Result<Self, AgentStudioApiError> {
        let mut parsed = Url::parse(base_url.trim()).map_err(|_| {
            AgentStudioApiError::local(
                "AUTH_NOT_CONFIGURED",
                "COMM_OFFICER_BASE_URL is not a valid URL.",
            )
        })?;
        validate_base_url(&parsed)?;
        parsed.set_query(None);
        parsed.set_fragment(None);
        let origin = origin_key(&parsed)?;
        let client = build_transport_client()?;
        let jar = Arc::new(Jar::default());
        let client = client.cookie_provider(jar.clone()).build().map_err(|_| {
            AgentStudioApiError::local(
                "AUTH_NOT_CONFIGURED",
                "Agent Studio HTTP transport could not be configured.",
            )
        })?;
        Ok(Self {
            base_url: parsed,
            origin,
            csrf_cookie_name: csrf_cookie_name
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(DEFAULT_CSRF_COOKIE)
                .to_string(),
            transport: Arc::new(Mutex::new(Transport { client, jar })),
        })
    }

    pub async fn reset_cookies(&self) -> Result<(), AgentStudioApiError> {
        let client = build_transport_client()?;
        let jar = Arc::new(Jar::default());
        let client = client.cookie_provider(jar.clone()).build().map_err(|_| {
            AgentStudioApiError::local(
                "AUTH_NOT_CONFIGURED",
                "Agent Studio HTTP transport could not be reset.",
            )
        })?;
        *self.transport.lock().await = Transport { client, jar };
        Ok(())
    }

    async fn snapshot(&self) -> Self {
        let transport = self.transport.lock().await.clone();
        Self {
            base_url: self.base_url.clone(),
            origin: self.origin.clone(),
            csrf_cookie_name: self.csrf_cookie_name.clone(),
            transport: Arc::new(Mutex::new(transport)),
        }
    }

    pub async fn preauthenticate(
        &self,
        username: &str,
        password: &str,
    ) -> Result<AuthPreauthenticateResult, AgentStudioApiError> {
        let mut result: AuthPreauthenticateResult = self
            .send_json(
                Method::POST,
                "/v1/auth/login/preauthenticate",
                Some(&serde_json::json!({ "username": username, "password": password })),
                false,
            )
            .await?;
        result.expires_at = canonical_datetime(&result.expires_at)?;
        if result.status != PREAUTHENTICATED_STATUS {
            return Err(AgentStudioApiError::invalid_response(
                "Agent Studio returned an invalid login-flow response.",
            ));
        }
        Ok(result)
    }

    pub async fn companies(&self) -> Result<Vec<AuthCompanySummary>, AgentStudioApiError> {
        let mut response: AuthCollectionResponse<AuthCompanySummary> = self
            .send_json(
                Method::GET,
                "/v1/auth/login/companies",
                None::<&Value>,
                false,
            )
            .await?;
        for item in &mut response.items {
            item.company_id = canonical_ocws_id(&item.company_id)?;
            normalize_non_empty(&mut item.company_name)?;
        }
        Ok(response.items)
    }

    pub async fn branches(
        &self,
        company_id: &str,
    ) -> Result<Vec<AuthBranchSummary>, AgentStudioApiError> {
        let company_id = canonical_ocws_id(company_id).map_err(|_| {
            AgentStudioApiError::local("AUTH_INVALID_REQUEST", "A valid company is required.")
        })?;
        let mut path = self.resolve_url("/v1/auth/login/branches")?;
        path.query_pairs_mut().append_pair("companyId", &company_id);
        let mut response: AuthCollectionResponse<AuthBranchSummary> = self
            .send_json_url(Method::GET, path, None::<&Value>, false)
            .await?;
        for item in &mut response.items {
            item.branch_id = canonical_ocws_id(&item.branch_id)?;
            item.company_id = canonical_ocws_id(&item.company_id)?;
            normalize_non_empty(&mut item.branch_name)?;
            if item.company_id != company_id {
                return Err(AgentStudioApiError::invalid_response(
                    "Agent Studio returned a branch for a different company.",
                ));
            }
        }
        Ok(response.items)
    }

    pub async fn complete(
        &self,
        company_id: &str,
        branch_id: &str,
        password: &str,
    ) -> Result<AuthSessionContext, AgentStudioApiError> {
        let company_id = canonical_ocws_id(company_id).map_err(|_| {
            AgentStudioApiError::local("AUTH_INVALID_REQUEST", "A valid company is required.")
        })?;
        let branch_id = canonical_ocws_id(branch_id).map_err(|_| {
            AgentStudioApiError::local("AUTH_INVALID_REQUEST", "A valid branch is required.")
        })?;
        let session: AuthSessionContext = self
            .send_json(
                Method::POST,
                "/v1/auth/login/complete",
                Some(&serde_json::json!({
                    "companyId": company_id,
                    "branchId": branch_id,
                    "password": password
                })),
                false,
            )
            .await?;
        session.validate()
    }

    pub async fn session(&self) -> Result<AuthSessionContext, AgentStudioApiError> {
        let session: AuthSessionContext = self
            .send_json(Method::GET, "/v1/auth/session", None::<&Value>, false)
            .await?;
        session.validate()
    }

    pub async fn logout(&self) -> Result<AuthLogoutResponse, AgentStudioApiError> {
        let response: AuthLogoutResponse = self
            .send_json(Method::POST, "/v1/auth/logout", None::<&Value>, true)
            .await?;
        if !response.success {
            return Err(AgentStudioApiError::invalid_response(
                "Agent Studio returned an invalid logout response.",
            ));
        }
        Ok(response)
    }

    pub async fn get_json<T: DeserializeOwned>(
        &self,
        path_or_url: &str,
    ) -> Result<T, AgentStudioApiError> {
        self.send_json(Method::GET, path_or_url, None::<&Value>, false)
            .await
    }

    pub async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        path_or_url: &str,
        body: &B,
    ) -> Result<T, AgentStudioApiError> {
        self.send_json(Method::POST, path_or_url, Some(body), true)
            .await
    }

    pub async fn post_json_with_idempotency<B: Serialize, T: DeserializeOwned>(
        &self,
        path_or_url: &str,
        body: &B,
        idempotency_key: &str,
    ) -> Result<T, AgentStudioApiError> {
        let key = idempotency_key.trim();
        if key.is_empty() {
            return Err(AgentStudioApiError::local(
                "AUTH_INVALID_REQUEST",
                "An idempotency key is required.",
            ));
        }
        let url = self.resolve_url(path_or_url)?;
        let transport = self.transport.lock().await.clone();
        let token = csrf_token(&transport.jar, &url, &self.csrf_cookie_name).ok_or_else(|| {
            AgentStudioApiError::local(
                "AUTH_CSRF_REQUIRED",
                "The Agent Studio session is missing its CSRF token.",
            )
        })?;
        let response = transport
            .client
            .post(url)
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .header(ORIGIN, &self.origin)
            .header(
                X_CSRF_TOKEN,
                HeaderValue::from_str(&token).map_err(|_| {
                    AgentStudioApiError::local(
                        "AUTH_CSRF_REQUIRED",
                        "The Agent Studio CSRF token is invalid.",
                    )
                })?,
            )
            .header(
                X_IDEMPOTENCY_KEY,
                HeaderValue::from_str(key).map_err(|_| {
                    AgentStudioApiError::local(
                        "AUTH_INVALID_REQUEST",
                        "The idempotency key is invalid.",
                    )
                })?,
            )
            .json(body)
            .send()
            .await
            .map_err(|_| AgentStudioApiError::network())?;
        if !response.status().is_success() {
            return Err(parse_error_response(response).await);
        }
        response.json::<T>().await.map_err(|_| {
            AgentStudioApiError::invalid_response("Agent Studio returned an invalid response.")
        })
    }

    pub async fn open_stream(&self, path_or_url: &str) -> Result<Response, AgentStudioApiError> {
        let url = self.resolve_url(path_or_url)?;
        let transport = self.transport.lock().await.clone();
        let response = transport
            .client
            .get(url)
            .header(ACCEPT, "text/event-stream")
            .header(ORIGIN, &self.origin)
            .send()
            .await
            .map_err(|_| AgentStudioApiError::network())?;
        if !response.status().is_success() {
            return Err(parse_error_response(response).await);
        }
        Ok(response)
    }

    async fn send_json<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        path_or_url: &str,
        body: Option<&B>,
        csrf_required: bool,
    ) -> Result<T, AgentStudioApiError> {
        let url = self.resolve_url(path_or_url)?;
        self.send_json_url(method, url, body, csrf_required).await
    }

    async fn send_json_url<B: Serialize, T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        body: Option<&B>,
        csrf_required: bool,
    ) -> Result<T, AgentStudioApiError> {
        let transport = self.transport.lock().await.clone();
        let mut request = transport
            .client
            .request(method.clone(), url.clone())
            .header(ACCEPT, "application/json")
            .header(ORIGIN, &self.origin);
        if let Some(body) = body {
            request = request.header(CONTENT_TYPE, "application/json").json(body);
        }
        if csrf_required {
            let token =
                csrf_token(&transport.jar, &url, &self.csrf_cookie_name).ok_or_else(|| {
                    AgentStudioApiError::local(
                        "AUTH_CSRF_REQUIRED",
                        "The Agent Studio session is missing its CSRF token.",
                    )
                })?;
            request = request.header(
                X_CSRF_TOKEN,
                HeaderValue::from_str(token.as_str()).map_err(|_| {
                    AgentStudioApiError::local(
                        "AUTH_CSRF_REQUIRED",
                        "The Agent Studio CSRF token is invalid.",
                    )
                })?,
            );
        }
        let response = request
            .send()
            .await
            .map_err(|_| AgentStudioApiError::network())?;
        if !response.status().is_success() {
            return Err(parse_error_response(response).await);
        }
        response.json::<T>().await.map_err(|_| {
            AgentStudioApiError::invalid_response("Agent Studio returned an invalid response.")
        })
    }

    fn resolve_url(&self, path_or_url: &str) -> Result<Url, AgentStudioApiError> {
        let raw = path_or_url.trim();
        if raw.is_empty() {
            return Err(AgentStudioApiError::local(
                "DESKTOP_BACKEND_ORIGIN_MISMATCH",
                "The Agent Studio request URL is empty.",
            ));
        }
        let candidate = Url::parse(raw)
            .or_else(|_| self.base_url.join(raw))
            .map_err(|_| {
                AgentStudioApiError::local(
                    "DESKTOP_BACKEND_ORIGIN_MISMATCH",
                    "The Agent Studio request URL is invalid.",
                )
            })?;
        if candidate.username() != ""
            || candidate.password().is_some()
            || origin_key(&candidate)? != self.origin
        {
            return Err(AgentStudioApiError::local(
                "DESKTOP_BACKEND_ORIGIN_MISMATCH",
                "The Agent Studio request origin is not allowed.",
            ));
        }
        Ok(candidate)
    }
}

fn build_transport_client() -> Result<reqwest::ClientBuilder, AgentStudioApiError> {
    Ok(Client::builder()
        .redirect(Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(60)))
}

fn validate_base_url(url: &Url) -> Result<(), AgentStudioApiError> {
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(AgentStudioApiError::local(
            "AUTH_NOT_CONFIGURED",
            "COMM_OFFICER_BASE_URL must be an origin URL without credentials.",
        ));
    }
    if url.scheme() == "http"
        && !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        )
    {
        return Err(AgentStudioApiError::local(
            "AUTH_NOT_CONFIGURED",
            "HTTP Agent Studio connections are allowed only for loopback development.",
        ));
    }
    Ok(())
}

fn origin_key(url: &Url) -> Result<String, AgentStudioApiError> {
    url.host_str().ok_or_else(|| {
        AgentStudioApiError::local(
            "DESKTOP_BACKEND_ORIGIN_MISMATCH",
            "The Agent Studio URL has no host.",
        )
    })?;
    Ok(url.origin().ascii_serialization())
}

fn csrf_token(jar: &Jar, url: &Url, cookie_name: &str) -> Option<String> {
    let header = jar.cookies(url)?;
    let raw = header.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        (name.trim() == cookie_name).then(|| value.trim().to_string())
    })
}

async fn parse_error_response(response: Response) -> AgentStudioApiError {
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0);
    let payload = response.json::<Value>().await.unwrap_or(Value::Null);
    let code = payload
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string);
    let message = match code.as_deref() {
        Some("AUTH_SESSION_REQUIRED") | Some("AUTH_SESSION_INVALID") => {
            "The Agent Studio session is no longer valid."
        }
        Some("AUTH_LOGIN_FLOW_INVALID") => "The login flow expired. Start again.",
        Some("AUTH_TENANT_NOT_OFFERED") => "That company or branch is not available.",
        Some("AUTH_CSRF_REQUIRED") => "The Agent Studio session security check failed.",
        Some("AUTH_ORIGIN_FORBIDDEN") => "The Agent Studio origin is not allowed.",
        Some("AUTH_OCWS_RATE_LIMITED") => "Agent Studio is rate limiting requests.",
        Some("AUTH_NOT_CONFIGURED") => "Agent Studio authentication is not configured.",
        _ if status == 429 => "Agent Studio is rate limiting requests.",
        _ if status >= 500 => "Agent Studio is currently unavailable.",
        _ => "Agent Studio rejected the request.",
    };
    AgentStudioApiError {
        status: Some(status),
        code,
        message: message.to_string(),
        retry_after,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_loopback_http_base_urls() {
        let error = AgentStudioApiClient::new("http://example.test", None)
            .err()
            .expect("non-loopback HTTP should be rejected");
        assert_eq!(error.code.as_deref(), Some("AUTH_NOT_CONFIGURED"));
    }

    #[test]
    fn accepts_loopback_development_origin() {
        assert!(AgentStudioApiClient::new("http://127.0.0.1:3200", None).is_ok());
    }

    #[test]
    fn serializes_browser_canonical_default_port_and_ipv6_origins() {
        let https = AgentStudioApiClient::new("https://studio.example.test", None).unwrap();
        let ipv6 = AgentStudioApiClient::new("http://[::1]:3200", None).unwrap();
        assert_eq!(https.origin, "https://studio.example.test");
        assert_eq!(ipv6.origin, "http://[::1]:3200");
    }

    #[test]
    fn reads_only_the_configured_csrf_cookie_from_the_in_memory_jar() {
        let client = AgentStudioApiClient::new("http://127.0.0.1:3200", Some("csrf_custom"))
            .expect("loopback transport should be configured");
        let url = Url::parse("http://127.0.0.1:3200/v1/auth/logout").unwrap();
        let jar = Jar::default();
        jar.add_cookie_str("agent_studio_csrf=ignored; Path=/", &url);
        jar.add_cookie_str("csrf_custom=token-123; Path=/", &url);

        assert_eq!(
            csrf_token(&jar, &url, &client.csrf_cookie_name),
            Some("token-123".to_string())
        );
    }

    #[test]
    fn rejects_cross_origin_stream_and_poll_urls() {
        let client = AgentStudioApiClient::new("https://studio.example.test", None)
            .expect("https origin should be accepted");

        assert!(client
            .resolve_url("https://other.example.test/events")
            .is_err());
        assert!(client
            .resolve_url("https://studio.example.test/v1/events")
            .is_ok());
    }

    #[test]
    fn bodyless_unauthorized_response_requires_reauthentication() {
        let error = AgentStudioApiError {
            status: Some(401),
            code: None,
            message: "Agent Studio rejected the request.".to_string(),
            retry_after: None,
        };

        assert!(error.requires_reauthentication());
    }

    #[test]
    fn validates_public_session_projection() {
        let tenant = TenantSummary {
            tenant_id: "tenant-a".to_string(),
            company_id: "701".to_string(),
            company_name: "Company A".to_string(),
            branch_id: "1".to_string(),
            branch_name: "Branch 1".to_string(),
            can_administer: true,
        };
        let session = AuthSessionContext {
            session_id: "session-a".to_string(),
            user: AuthUser {
                id: "user-a".to_string(),
                username: "alice".to_string(),
                display_name: None,
                global_authorities: Vec::new(),
            },
            selected_tenant: tenant.clone(),
            accessible_tenants: vec![tenant.clone()],
            administrable_tenant_ids: vec![tenant.tenant_id.clone()],
            expires_at: "2026-08-25T12:00:00+00:00".to_string(),
        };
        assert!(session.validate().is_ok());
    }

    #[test]
    fn rejects_non_admin_or_non_numeric_tenant_projection() {
        let tenant = TenantSummary {
            tenant_id: "tenant-member".to_string(),
            company_id: "company-1".to_string(),
            company_name: "Company".to_string(),
            branch_id: "branch-1".to_string(),
            branch_name: "Branch".to_string(),
            can_administer: false,
        };
        let session = AuthSessionContext {
            session_id: "session-member".to_string(),
            user: AuthUser {
                id: "user-member".to_string(),
                username: "member".to_string(),
                display_name: None,
                global_authorities: Vec::new(),
            },
            selected_tenant: tenant.clone(),
            accessible_tenants: vec![tenant],
            administrable_tenant_ids: Vec::new(),
            expires_at: "2026-08-25T12:00:00+00:00".to_string(),
        };
        assert!(session.validate().is_err());
    }

    #[test]
    fn canonicalizes_ocws_ids_and_rejects_unsafe_values() {
        assert_eq!(canonical_ocws_id(" 001 ").unwrap(), "1");
        assert!(canonical_ocws_id("company-1").is_err());
        assert!(canonical_ocws_id("9007199254740992").is_err());
    }

    #[test]
    fn rejects_invalid_session_datetime_and_unknown_contract_fields() {
        let mut session = test_session("session-a", "tenant-a");
        session.expires_at = "not-a-date".to_string();
        assert!(session.validate().is_err());

        let unknown = serde_json::json!({
            "status": "PREAUTHENTICATED",
            "expiresAt": "2099-01-01T00:00:00Z",
            "tenantId": "must-not-be-accepted"
        });
        assert!(serde_json::from_value::<AuthPreauthenticateResult>(unknown).is_err());
    }

    fn test_session(session_id: &str, tenant_id: &str) -> AuthSessionContext {
        let tenant = TenantSummary {
            tenant_id: tenant_id.to_string(),
            company_id: "701".to_string(),
            company_name: format!("Company {tenant_id}"),
            branch_id: "1".to_string(),
            branch_name: format!("Branch {tenant_id}"),
            can_administer: true,
        };
        AuthSessionContext {
            session_id: session_id.to_string(),
            user: AuthUser {
                id: "user-a".to_string(),
                username: "alice".to_string(),
                display_name: None,
                global_authorities: Vec::new(),
            },
            selected_tenant: tenant.clone(),
            accessible_tenants: vec![tenant.clone()],
            administrable_tenant_ids: vec![tenant.tenant_id.clone()],
            expires_at: "2026-08-25T12:00:00+00:00".to_string(),
        }
    }

    #[tokio::test]
    async fn rejects_stale_context_after_invalidation() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = AgentStudioSessionBroker::new(api);
        let active = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();

        assert!(broker.require_current(&active.context_id).await.is_ok());
        broker.invalidate().await.unwrap();
        let error = broker
            .require_current(&active.context_id)
            .await
            .unwrap_err();

        assert_eq!(error.code.as_deref(), Some("DESKTOP_SESSION_CHANGED"));
        assert!(
            !broker
                .is_current(&active.context_id, active.local_epoch)
                .await
        );
    }

    #[tokio::test]
    async fn invalidation_clears_pending_login_password() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = AgentStudioSessionBroker::new(api);
        *broker.pending_password.lock().await = Some("secret".to_string());
        *broker.login_flow_expires_at.lock().await = Some(OffsetDateTime::now_utc());
        broker.invalidate().await.unwrap();
        assert!(broker.pending_password.lock().await.is_none());
        assert!(broker.login_flow_expires_at.lock().await.is_none());
    }

    #[tokio::test]
    async fn active_session_requires_logout_before_new_preauthentication() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = AgentStudioSessionBroker::new(api);
        let active = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();

        let result = broker
            .preauthenticate_with_invalidation("bob", "secret", || async {})
            .await;

        assert_eq!(
            result.unwrap_err().code.as_deref(),
            Some("AUTH_INVALID_REQUEST")
        );
        assert!(broker.require_current(&active.context_id).await.is_ok());
    }

    #[tokio::test]
    async fn execution_context_keeps_the_transport_bound_to_its_session_epoch() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let cookie_url = Url::parse("http://127.0.0.1:3200/v1/desktop-avatar/requests").unwrap();
        {
            let transport = api.transport.lock().await;
            transport
                .jar
                .add_cookie_str("agent_studio_session=tenant-a; Path=/", &cookie_url);
        }
        let broker = AgentStudioSessionBroker::new(api);
        let active = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();
        let execution = broker
            .require_execution_context(&active.context_id)
            .await
            .unwrap();

        broker.invalidate().await.unwrap();

        let captured_cookie = {
            let transport = execution.api.transport.lock().await;
            transport.jar.cookies(&cookie_url)
        };
        let replacement_cookie = {
            let transport = broker.api.transport.lock().await;
            transport.jar.cookies(&cookie_url)
        };
        assert!(captured_cookie
            .and_then(|value| value.to_str().ok().map(str::to_string))
            .is_some_and(|value| value.contains("agent_studio_session=tenant-a")));
        assert!(replacement_cookie.is_none());
    }

    #[tokio::test]
    async fn activating_new_session_invalidates_old_epoch() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = AgentStudioSessionBroker::new(api);
        let first = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();
        let second = broker
            .activate(test_session("session-b", "tenant-b"))
            .await
            .unwrap();

        assert_ne!(first.context_id, second.context_id);
        assert!(second.local_epoch > first.local_epoch);
        assert!(broker.require_current(&first.context_id).await.is_err());
        assert!(broker.require_current(&second.context_id).await.is_ok());
    }

    #[tokio::test]
    async fn logout_relogin_rejects_input_bound_to_previous_context() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = AgentStudioSessionBroker::new(api);
        let before_logout = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();

        broker.invalidate().await.unwrap();
        let after_relogin = broker
            .activate(test_session("session-b", "tenant-b"))
            .await
            .unwrap();

        assert!(broker
            .require_current(&before_logout.context_id)
            .await
            .is_err());
        assert!(broker
            .require_current(&after_relogin.context_id)
            .await
            .is_ok());
        assert!(
            !broker
                .is_current(&before_logout.context_id, before_logout.local_epoch)
                .await
        );
    }

    #[tokio::test]
    async fn context_bound_registration_finishes_before_invalidation() {
        let api = AgentStudioApiClient::new("http://127.0.0.1:3200", None).unwrap();
        let broker = Arc::new(AgentStudioSessionBroker::new(api));
        let active = broker
            .activate(test_session("session-a", "tenant-a"))
            .await
            .unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let guarded_broker = broker.clone();
        let context_id = active.context_id.clone();
        let guarded_start = tokio::spawn(async move {
            guarded_broker
                .run_if_current(&context_id, || async move {
                    let _ = entered_tx.send(());
                    let _ = release_rx.await;
                    Ok(())
                })
                .await
        });
        entered_rx.await.unwrap();

        let invalidating_broker = broker.clone();
        let invalidation = tokio::spawn(async move { invalidating_broker.invalidate().await });
        tokio::task::yield_now().await;
        assert!(
            !invalidation.is_finished(),
            "logout must wait until context-owned work is registered"
        );

        let _ = release_tx.send(());
        guarded_start.await.unwrap().unwrap();
        invalidation.await.unwrap().unwrap();
        assert!(broker.require_current(&active.context_id).await.is_err());
    }
}
