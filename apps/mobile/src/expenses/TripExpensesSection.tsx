import {
  EXPENSE_CATEGORIES,
  type Expense,
  type ExpenseCategory,
  type Page,
  type TripStatus,
} from '@mansar/types';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  formatTripTime,
  manilaLocalNow,
  manilaLocalToInstant,
} from '../trips/trip-time';
import type { DriverExpensesApi } from './driver-expenses-api';
import {
  driverExpenseMessage,
  EXPENSE_FALLBACK,
} from './driver-expense-messages';
import { formatPhp, isValidExpenseAmountInput } from './money';

/** One server page; the driver endpoint's own default. */
export const PAGE_SIZE = 25;

/** The description ceiling the API enforces. */
export const DESCRIPTION_MAX_LENGTH = 500;

/**
 * Trip states a driver may file an expense against, mirroring the API's
 * `DRIVER_EXPENSABLE_FROM`. Broadening this locally would only produce a 409.
 */
export const EXPENSABLE_FROM: readonly TripStatus[] = [
  'IN_PROGRESS',
  'COMPLETED',
];

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly page: Page<Expense> }
  | { readonly kind: 'error'; readonly message: string };

interface Props {
  readonly tripId: string;
  readonly tripStatus: TripStatus;
  readonly api: DriverExpensesApi;
  readonly onOpenExpense: (expenseId: string) => void;
}

/**
 * The expenses on one of the driver's own trips, and the form to file another.
 *
 * Listing is trip-scoped because the API is: there is no cross-trip driver
 * expense endpoint, so one request covers this section and there is no
 * per-trip fan-out anywhere.
 *
 * The amount is held as a string from keystroke to request. An expense amount
 * is a `Decimal(12, 2)` that crosses the wire as a decimal string precisely so
 * it cannot be rounded through a double, and parsing it here to validate it
 * would undo that at the last moment.
 *
 * Nothing is added to the list optimistically. The 201 response proves the
 * expense exists, and the authoritative list is then re-read — a locally
 * constructed row would be this screen's guess at what the server stored.
 */
export function TripExpensesSection({
  tripId,
  tripStatus,
  api,
  onOpenExpense,
}: Props) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('FUEL');
  const [incurredAt, setIncurredAt] = useState(() => manilaLocalNow());
  const [description, setDescription] = useState('');

  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const page = await api.list(tripId, { page: 1, pageSize: PAGE_SIZE });
        if (!cancelled) {
          setState({ kind: 'ready', page });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: driverExpenseMessage(error, EXPENSE_FALLBACK.list),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, tripId, reloadToken]);

  const canFile = EXPENSABLE_FROM.includes(tripStatus);

  const submit = async () => {
    if (busy) {
      return;
    }
    setFormError(null);
    setOutcome(null);

    if (!isValidExpenseAmountInput(amount)) {
      setFormError(
        'Enter an amount greater than zero, with at most two decimal places.',
      );
      return;
    }
    const instant = manilaLocalToInstant(incurredAt);
    if (instant === null) {
      setFormError('Enter the time it was incurred as YYYY-MM-DD HH:MM.');
      return;
    }

    setBusy(true);
    try {
      await api.create(tripId, {
        amount,
        category,
        incurredAt: instant,
        description,
      });
      if (!mounted.current) {
        return;
      }
      // The server's list is the authority on what now exists.
      setState({ kind: 'loading' });
      setReloadToken((token) => token + 1);
      setAmount('');
      setDescription('');
      setIncurredAt(manilaLocalNow());
      setOutcome('Expense filed.');
    } catch (error) {
      if (mounted.current) {
        setFormError(driverExpenseMessage(error, EXPENSE_FALLBACK.create));
      }
    }
    if (mounted.current) {
      setBusy(false);
    }
  };

  const retry = () => {
    setState({ kind: 'loading' });
    setReloadToken((token) => token + 1);
  };

  return (
    <View>
      <Text style={styles.heading}>Expenses</Text>

      {state.kind === 'loading' ? (
        <ActivityIndicator accessibilityLabel="Loading expenses" />
      ) : null}

      {state.kind === 'error' ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {state.message}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retry}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {state.kind === 'ready' && state.page.items.length === 0 ? (
        <Text style={styles.line}>No expenses filed on this trip.</Text>
      ) : null}

      {state.kind === 'ready' && state.page.items.length > 0 ? (
        <View>
          <Text style={styles.line}>
            {state.page.total} expense{state.page.total === 1 ? '' : 's'} on
            this trip
          </Text>
          {state.page.items.map((expense) => (
            <Pressable
              accessibilityRole="button"
              key={expense.id}
              onPress={() => onOpenExpense(expense.id)}
              style={styles.row}
            >
              <Text style={styles.rowTitle}>{formatPhp(expense.amount)}</Text>
              <Text style={styles.rowLine}>
                {formatTripTime(expense.incurredAt)}
              </Text>
              <Text style={styles.rowLine}>
                {expense.category} · {expense.status}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* The API accepts a driver-filed expense only while a trip is running
          or finished, so the form is absent elsewhere rather than disabled. */}
      {canFile ? (
        <View style={styles.form}>
          <Text style={styles.heading}>Add expense</Text>

          <Text style={styles.label}>Amount (PHP)</Text>
          <TextInput
            accessibilityLabel="Amount (PHP)"
            autoCorrect={false}
            editable={!busy}
            keyboardType="decimal-pad"
            onChangeText={setAmount}
            placeholder="0.00"
            style={styles.input}
            value={amount}
          />

          <Text style={styles.label}>Category</Text>
          <View style={styles.categories}>
            {EXPENSE_CATEGORIES.map((option) => (
              <Pressable
                accessibilityLabel={`Category ${option}`}
                accessibilityRole="button"
                accessibilityState={{ selected: category === option }}
                disabled={busy}
                key={option}
                onPress={() => setCategory(option)}
                style={[
                  styles.category,
                  category === option && styles.categorySelected,
                ]}
              >
                <Text style={styles.categoryText}>{option}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Incurred at (Asia/Manila)</Text>
          <TextInput
            accessibilityLabel="Incurred at (Asia/Manila)"
            autoCorrect={false}
            editable={!busy}
            onChangeText={setIncurredAt}
            placeholder="YYYY-MM-DD HH:MM"
            style={styles.input}
            value={incurredAt}
          />

          <Text style={styles.label}>Description</Text>
          <TextInput
            accessibilityLabel="Description"
            editable={!busy}
            maxLength={DESCRIPTION_MAX_LENGTH}
            multiline
            onChangeText={setDescription}
            style={[styles.input, styles.multiline]}
            value={description}
          />

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() => {
              void submit();
            }}
            style={[styles.button, busy && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>Add expense</Text>
          </Pressable>

          {formError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {formError}
            </Text>
          ) : null}
          {outcome ? <Text style={styles.outcome}>{outcome}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 20,
  },
  line: {
    fontSize: 16,
    marginBottom: 6,
  },
  label: {
    fontSize: 14,
    marginBottom: 4,
    marginTop: 10,
  },
  input: {
    borderColor: '#9aa5b1',
    borderRadius: 4,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  multiline: {
    minHeight: 80,
    paddingTop: 12,
    textAlignVertical: 'top',
  },
  form: {
    marginTop: 8,
  },
  categories: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  category: {
    borderColor: '#9aa5b1',
    borderRadius: 4,
    borderWidth: 1,
    marginBottom: 8,
    marginRight: 8,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  categorySelected: {
    borderColor: '#1f4e79',
    borderWidth: 2,
  },
  categoryText: {
    fontSize: 14,
  },
  row: {
    borderColor: '#d9dde1',
    borderRadius: 4,
    borderWidth: 1,
    marginBottom: 8,
    padding: 12,
  },
  rowTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  rowLine: {
    fontSize: 14,
    marginTop: 2,
  },
  error: {
    color: '#8a1f1f',
    fontSize: 16,
    marginTop: 12,
  },
  outcome: {
    color: '#1f5c2e',
    fontSize: 16,
    marginTop: 12,
  },
  button: {
    alignItems: 'center',
    borderColor: '#1f4e79',
    borderRadius: 4,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#1f4e79',
    fontSize: 16,
    fontWeight: '600',
  },
});
