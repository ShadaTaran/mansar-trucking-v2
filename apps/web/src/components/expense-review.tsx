'use client';

import type { Expense } from '@mansar/types';
import { useState } from 'react';

import {
  adminErrorMessage,
  approveExpense,
  rejectExpense,
} from '@/lib/client/admin-api';

export const REVIEW_NOTE_MAX_LENGTH = 500;

interface Props {
  readonly expense: Expense;
  /** Receives the authoritative expense the API returned. */
  readonly onChanged: (expense: Expense) => void;
  /** Another admin won the review; the parent should re-read the expense. */
  readonly onStale: () => void;
}

type Decision = 'APPROVE' | 'REJECT';

const WORDING: Readonly<
  Record<Decision, { question: string; confirm: string; outcome: string }>
> = {
  APPROVE: {
    question: 'Approve this expense?',
    confirm: 'Confirm approval',
    outcome: 'Expense approved.',
  },
  REJECT: {
    question: 'Reject this expense?',
    confirm: 'Confirm rejection',
    outcome: 'Expense rejected.',
  },
};

/**
 * Approve or reject a submitted expense.
 *
 * Both decisions are confirmed, exactly as every irreversible trip
 * transition is. APPROVED and REJECTED are terminal — there is no reopen —
 * so an accidental click costs a new expense and an explanation, which is
 * reason enough to ask twice.
 *
 * The note is one field shared by both paths because the API treats it as
 * one field: optional on approval, required on rejection, where it is the
 * submitter's only feedback. A whitespace-only rejection never becomes a
 * request; the server would refuse it, and a round trip to be told so is
 * worse than saying it immediately.
 *
 * Nothing here guesses the outcome. The authoritative expense comes back
 * from the API and is handed to the parent, so the summary, the status and
 * the review metadata all change together and the controls disappear
 * because the expense is genuinely terminal.
 */
export function ExpenseReview({ expense, onChanged, onStale }: Props) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  if (expense.status !== 'SUBMITTED') {
    return null;
  }

  const start = (next: Decision) => {
    setDecision(next);
    setError(null);
    setOutcome(null);
  };

  const apply = async () => {
    if (decision === null) {
      return;
    }
    const note = reviewNote.trim();
    if (decision === 'REJECT' && note === '') {
      setError('Enter a reason for rejecting this expense.');
      return;
    }

    setBusy(true);
    setError(null);
    const result =
      decision === 'APPROVE'
        ? await approveExpense(expense.id, note === '' ? undefined : note)
        : await rejectExpense(expense.id, note);
    setBusy(false);

    if (!result.ok) {
      setError(adminErrorMessage(result));
      setDecision(null);
      if (result.code === 'expense_not_reviewable') {
        // Someone else reviewed it first. Leaving a review form on a
        // terminal expense would invite a second doomed attempt, so ask the
        // parent for the real state rather than guessing at it here.
        onStale();
      }
      return;
    }

    setOutcome(WORDING[decision].outcome);
    setDecision(null);
    onChanged(result.data);
  };

  return (
    <section aria-labelledby="expense-review-heading">
      <h2 id="expense-review-heading">Review</h2>
      <p>
        This expense is <strong>SUBMITTED</strong> and awaiting a decision.
      </p>

      <p>
        <label htmlFor="expense-review-note">Review note</label>
        <br />
        <textarea
          id="expense-review-note"
          name="reviewNote"
          value={reviewNote}
          maxLength={REVIEW_NOTE_MAX_LENGTH}
          rows={3}
          disabled={busy}
          onChange={(event) => setReviewNote(event.target.value)}
        />
        <br />
        <small>Optional when approving. Required when rejecting.</small>
      </p>

      {decision === null ? (
        <p>
          <button
            type="button"
            onClick={() => start('APPROVE')}
            disabled={busy}
          >
            Approve expense
          </button>{' '}
          <button type="button" onClick={() => start('REJECT')} disabled={busy}>
            Reject expense
          </button>
        </p>
      ) : (
        <div role="group" aria-labelledby="expense-review-confirm">
          <p id="expense-review-confirm">{WORDING[decision].question}</p>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy}
            aria-busy={busy}
          >
            {WORDING[decision].confirm}
          </button>{' '}
          <button
            type="button"
            onClick={() => setDecision(null)}
            disabled={busy}
          >
            Keep submitted
          </button>
        </div>
      )}

      {error ? <p role="alert">{error}</p> : null}
      {outcome ? <p role="status">{outcome}</p> : null}
    </section>
  );
}
