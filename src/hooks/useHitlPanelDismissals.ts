import { useCallback, useEffect, useRef, useState } from "react";

interface HitlDecisionReference {
  decisionId: string;
}

export function useHitlPanelDismissals(
  liveDecisions: readonly HitlDecisionReference[],
  isExpanded: boolean
) {
  const [dismissedDecisionIds, setDismissedDecisionIds] = useState<Set<string>>(
    () => new Set()
  );
  const wasExpandedRef = useRef(isExpanded);

  useEffect(() => {
    const reopened = isExpanded && !wasExpandedRef.current;
    wasExpandedRef.current = isExpanded;

    if (reopened) {
      setDismissedDecisionIds((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const liveDecisionIds = new Set(liveDecisions.map((decision) => decision.decisionId));
    setDismissedDecisionIds((current) => {
      const next = new Set([...current].filter((decisionId) => liveDecisionIds.has(decisionId)));
      return next.size === current.size ? current : next;
    });
  }, [isExpanded, liveDecisions]);

  const dismissDecision = useCallback((decisionId: string) => {
    setDismissedDecisionIds((current) => {
      if (current.has(decisionId)) {
        return current;
      }
      const next = new Set(current);
      next.add(decisionId);
      return next;
    });
  }, []);

  const dismissDecisions = useCallback((decisionIds: Iterable<string>) => {
    setDismissedDecisionIds((current) => {
      const next = new Set(current);
      for (const decisionId of decisionIds) {
        next.add(decisionId);
      }
      return next.size === current.size ? current : next;
    });
  }, []);

  return {
    dismissedDecisionIds,
    dismissDecision,
    dismissDecisions
  };
}
