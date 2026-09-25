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
 * `expenseNotModifiable` belongs to the frozen Stage 6 contract and is
 * declared here so the public error namespace stays in one place, as
 * DRIVER_ERROR and TRIP_ERROR already do. Stage 6B has no editable or
 * receipt mutation, so no route returns it yet.
 */
export const EXPENSE_ERROR = {
  expenseNotFound: 'expense_not_found',
  expenseNotReviewable: 'expense_not_reviewable',
  expenseNotModifiable: 'expense_not_modifiable',
  tripNotExpensable: 'trip_not_expensable',
} as const;

export type ExpenseErrorCode =
  (typeof EXPENSE_ERROR)[keyof typeof EXPENSE_ERROR];
