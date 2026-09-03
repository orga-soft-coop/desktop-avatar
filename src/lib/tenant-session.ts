import type { DesktopAvatarTenantSession } from "./auth-contracts";

let activeSession: Readonly<DesktopAvatarTenantSession> | null = null;

export function activateTenantSession(
  session: DesktopAvatarTenantSession
): Readonly<DesktopAvatarTenantSession> {
  const freezeTenant = (tenant: DesktopAvatarTenantSession["publicSession"]["selectedTenant"]) =>
    Object.freeze({ ...tenant });
  const frozen = Object.freeze({
    ...session,
    publicSession: Object.freeze({
      ...session.publicSession,
      user: Object.freeze({
        ...session.publicSession.user,
        globalAuthorities: Object.freeze([...session.publicSession.user.globalAuthorities])
      }),
      selectedTenant: freezeTenant(session.publicSession.selectedTenant),
      accessibleTenants: Object.freeze(session.publicSession.accessibleTenants.map(freezeTenant)),
      administrableTenantIds: Object.freeze([...session.publicSession.administrableTenantIds])
    })
  });
  activeSession = frozen;
  return frozen;
}

export function clearTenantSession(): void {
  activeSession = null;
}

export function getRequiredTenantContextId(): string {
  if (!activeSession?.contextId) {
    throw new Error("DESKTOP_SESSION_CHANGED");
  }
  return activeSession.contextId;
}

export function isCurrentTenantContext(contextId: string | undefined): boolean {
  return Boolean(contextId && activeSession?.contextId === contextId);
}
