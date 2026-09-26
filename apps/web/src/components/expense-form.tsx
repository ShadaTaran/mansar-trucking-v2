'use client';

import { EXPENSE_CATEGORIES, type Expense } from '@mansar/types';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  type CreateExpenseInput,
  createTripExpense,
} from '@/lib/client/admin-api';
import { isValidExpenseAmountInput } from '@/lib/money';
import { manilaLocalToIso } from '@/lib/trip-time';

export const DESCRIPTION_MAX_LENGTH = 500;
/** Ten integer digits, a dot, two fractional digits. */
export const AMOUNT_MAX_LENGTH = 13;
const AMOUNT_PATTERN = '[0-9]{1,10}([.][0-9]{1,2})?';

const AMOUNT_INVALID =
  'Enter an amount greater than zero, with at most two decimal places.';
const INCURRED_INVALID = 'Enter a valid date and time.';

interface Props {
  readonly tripId: string;
  /** Receives the authoritative expense the API created. */
  readonly onCreated: (expense: Expense) => void;
}

interface FormValues {
  readonly amount: string;
  readonly category: string;
  readonly incurredAt: string;
  readonly description: string;
}

const EMPTY: FormValues = {
  amount: '',
  category: EXPENSE_CATEGORIES[0],
  incurredAt: '',
  description: '',
};

/**
 * ADMIN-on-behalf expense entry, for post-trip paperwork that reached the
 * office rather than the driver app.
 *
 * Four fields, which is the whole of what the API accepts. There is no
 * currency (amounts are PHP and the column has no currency), no driver
 * (ownership is the trip's), no status (every expense is created
 * SUBMITTED), no review note, and no receipt — attaching one is a separate
 * workflow on the expense itself.
 *
 * `amount` is a string in React state from the first keystroke to the
 * request body. `type="number"` is deliberately avoided: its
 * `valueAsNumber` and stepper semantics would drag a monetary value through
 * a float, which is the one thing this codebase refuses at every layer.
 */
export function ExpenseForm({ tripId, onCreated }: Props) {
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);

  const set = <K extends keyof FormValues>(key: K, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setDetails([]);
    setOutcome(null);

    // Checked as a string, by the same rule the API applies. Catching a
    // zero here saves a round trip; the server remains the authority.
    if (!isValidExpenseAmountInput(values.amount)) {
      setError(AMOUNT_INVALID);
      return;
    }
    // A datetime-local input carries no zone, so the value is read as
    // Manila wall-clock and converted explicitly, exactly as the trip
    // schedule fields are.
    const incurredAt = manilaLocalToIso(values.incurredAt);
    if (incurredAt === null) {
      setError(INCURRED_INVALID);
      return;
    }

    const input: CreateExpenseInput = {
      amount: values.amount,
      category: values.category as CreateExpenseInput['category'],
      incurredAt,
      description: values.description,
    };

    setBusy(true);
    const result = await createTripExpense(tripId, input);
    setBusy(false);

    if (!result.ok) {
      // Typed values stay put so nothing has to be re-entered.
      setError(adminErrorMessage(result));
      setDetails(result.validationMessages ?? []);
      return;
    }
    setValues(EMPTY);
    setOutcome('Expense submitted for review.');
    onCreated(result.data);
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h3>Add expense</h3>
      <p>
        <label htmlFor="expense-amount">Amount (PHP)</label>
        <br />
        <input
          id="expense-amount"
          name="amount"
          type="text"
          inputMode="decimal"
          value={values.amount}
          maxLength={AMOUNT_MAX_LENGTH}
          pattern={AMOUNT_PATTERN}
          required
          onChange={(event) => set('amount', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="expense-category">Category</label>
        <br />
        <select
          id="expense-category"
          name="category"
          value={values.category}
          onChange={(event) => set('category', event.target.value)}
        >
          {EXPENSE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor="expense-incurred-at">Incurred at (Asia/Manila)</label>
        <br />
        <input
          id="expense-incurred-at"
          name="incurredAt"
          type="datetime-local"
          value={values.incurredAt}
          required
          onChange={(event) => set('incurredAt', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor="expense-description">Description</label>
        <br />
        <textarea
          id="expense-description"
          name="description"
          value={values.description}
          maxLength={DESCRIPTION_MAX_LENGTH}
          rows={3}
          onChange={(event) => set('description', event.target.value)}
        />
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          {details.length > 0 ? (
            <ul>
              {details.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {outcome ? <p role="status">{outcome}</p> : null}
      <p>
        <button type="submit" disabled={busy}>
          Add expense
        </button>
      </p>
    </form>
  );
}
