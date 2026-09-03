export interface AgentStudioApiError {
  status?: number | null;
  code?: string | null;
  message: string;
  retryAfter?: number | null;
}

export interface AuthCompanySummary {
  companyId: string;
  companyName: string;
}

export interface AuthBranchSummary {
  companyId: string;
  branchId: string;
  branchName: string;
}

export interface TenantSummary {
  tenantId: string;
  companyId: string;
  companyName: string;
  branchId: string;
  branchName: string;
  canAdminister: boolean;
}

export interface AuthSessionContext {
  sessionId: string;
  user: {
    id: string;
    username: string;
    displayName?: string | null;
    globalAuthorities: readonly string[];
  };
  selectedTenant: TenantSummary;
  accessibleTenants: readonly TenantSummary[];
  administrableTenantIds: readonly string[];
  expiresAt: string;
}

export interface DesktopAvatarTenantSession {
  readonly contextId: string;
  readonly publicSession: AuthSessionContext;
  readonly localEpoch: number;
}

export interface AuthPreauthenticateResult {
  status: "PREAUTHENTICATED";
  expiresAt: string;
}
