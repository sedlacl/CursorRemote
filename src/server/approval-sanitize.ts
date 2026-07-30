import type { Approval, ApprovalAction, CursorState, GlobalApprovalNotification } from './types.js';

export type ClientApprovalAction = Pick<ApprovalAction, 'label' | 'type'>;

export type ClientApproval = Omit<Approval, 'actions'> & {
  actions: ClientApprovalAction[];
};

export function sanitizeApprovalForClient(approval: Approval): ClientApproval {
  const { actions, ...rest } = approval;
  return {
    ...rest,
    actions: actions.map(({ label, type }) => ({ label, type })),
  };
}

export function sanitizeApprovalsForClient(approvals: Approval[]): ClientApproval[] {
  return approvals.map(sanitizeApprovalForClient);
}

export function sanitizeStateForClient(state: CursorState): CursorState {
  return {
    ...state,
    pendingApprovals: sanitizeApprovalsForClient(state.pendingApprovals) as Approval[],
    globalApprovalNotifications: state.globalApprovalNotifications ?? [],
  };
}

export function sanitizePatchForClient(patch: Partial<CursorState>): Partial<CursorState> {
  const next: Partial<CursorState> = { ...patch };
  if (patch.pendingApprovals) {
    next.pendingApprovals = sanitizeApprovalsForClient(patch.pendingApprovals) as Approval[];
  }
  if (patch.globalApprovalNotifications) {
    next.globalApprovalNotifications = patch.globalApprovalNotifications as GlobalApprovalNotification[];
  }
  return next;
}
