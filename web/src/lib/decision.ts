export type ApprovalDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message?: string }
