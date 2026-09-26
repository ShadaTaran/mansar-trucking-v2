/**
 * Externally visible expenses error codes (the HTTP `message` field). Fixed
 * strings: they never carry an amount, description, review note, category,
 * driver name or any PostgreSQL text.
 *
 * `expenseNotReviewable` is deliberately the single answer for "already
 * approved", "already rejected" and "another reviewer won the race". A
 * reviewer learns only that their decision did not land, never which of the
 * three happened, so the code leaks nothing about a concurrent actor.
 *
 * `expenseNotModifiable` means one thing, frozen in Stage 6D: a receipt
 * mutation that requires the expense to stay open was requested after the
 * expense left SUBMITTED. It is never the answer for a receipt that is
 * itself closed — a confirmed receipt on a still-open expense is
 * `receipt_not_modifiable`, because telling the caller to reopen an expense
 * that was never the obstacle would send them to fix the wrong thing.
 */
export const EXPENSE_ERROR = {
  expenseNotFound: 'expense_not_found',
  expenseNotReviewable: 'expense_not_reviewable',
  expenseNotModifiable: 'expense_not_modifiable',
  tripNotExpensable: 'trip_not_expensable',
} as const;

export type ExpenseErrorCode =
  (typeof EXPENSE_ERROR)[keyof typeof EXPENSE_ERROR];
