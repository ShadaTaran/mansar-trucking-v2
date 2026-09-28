'use client';

import { MAINTENANCE_CATEGORIES, type MaintenanceRecord } from '@mansar/types';
import { type FormEvent, useState } from 'react';

import {
  adminErrorMessage,
  type CreateMaintenanceInput,
  createVehicleMaintenance,
  type UpdateMaintenanceInput,
  updateMaintenance,
} from '@/lib/client/admin-api';
import { isValidMaintenanceCostInput } from '@/lib/money';
import { isoToManilaLocal, manilaLocalToIso } from '@/lib/trip-time';

/** Mirrors `maintenance.schemas.ts`; the server remains the authority. */
export const DESCRIPTION_MAX_LENGTH = 2000;
/** Ten integer digits, a dot, two fractional digits. */
export const COST_MAX_LENGTH = 13;
const COST_PATTERN = '[0-9]{1,10}([.][0-9]{1,2})?';

/** Digits only: a reading is a whole number of units and never negative. */
const ODOMETER_PATTERN = /^[0-9]+$/;

const STARTED_INVALID = 'Enter a valid date and time.';
const ODOMETER_INVALID =
  'Enter the odometer as a whole number, or leave it blank.';
const COST_INVALID = 'Enter a cost with at most two decimal places.';

const CREATED = 'Maintenance record created.';
const UPDATED = 'Maintenance record updated.';
const UNCHANGED = 'No changes to save.';

interface Shared {
  /** Receives the authoritative record the API returned. */
  readonly onSaved: (record: MaintenanceRecord) => void;
}

interface CreateProps extends Shared {
  readonly vehicleId: string;
  readonly record?: undefined;
  readonly onStale?: undefined;
}

interface EditProps extends Shared {
  readonly record: MaintenanceRecord;
  readonly vehicleId?: undefined;
  /** Another admin finished or cancelled it first; the parent should re-read. */
  readonly onStale: () => void;
}

type Props = CreateProps | EditProps;

interface FormValues {
  readonly category: string;
  /** Manila wall-clock, as a `datetime-local` input carries it. */
  readonly startedAt: string;
  readonly description: string;
  /** Kept as typed text so a blank stays distinguishable from a zero. */
  readonly odometer: string;
  /** A string from the first keystroke to the request body. */
  readonly cost: string;
}

const EMPTY: FormValues = {
  category: MAINTENANCE_CATEGORIES[0],
  startedAt: '',
  description: '',
  odometer: '',
  cost: '',
};

/**
 * The stored record as form text. Used both to populate an edit form and as
 * the baseline the PATCH is diffed against, so the two can never disagree.
 */
function toValues(record: MaintenanceRecord): FormValues {
  return {
    category: record.category,
    startedAt: isoToManilaLocal(record.startedAt) ?? '',
    description: record.description,
    odometer: record.odometer === null ? '' : String(record.odometer),
    cost: record.cost ?? '',
  };
}

/**
 * One form for both filing a maintenance record and editing an OPEN one.
 *
 * Five fields, which is the whole of what the API accepts. There is no status
 * and no completion instant: a record is always created OPEN, and the
 * lifecycle moves only through *Complete* and *Cancel*, which live in
 * `MaintenanceActions` rather than here. Combining them would put a terminal,
 * irreversible decision behind the same *Save* button as a typo fix.
 *
 * `vehicleId` never appears in a request body — it belongs to the creation
 * route — and a record never changes vehicle, so the edit form has no vehicle
 * field at all.
 *
 * Editing sends only what actually changed. Resending all five stored values
 * would turn a one-word description fix into a write that also re-asserts the
 * cost and odometer, and would overwrite whatever another admin had corrected
 * in the meantime.
 */
export function MaintenanceForm({
  vehicleId,
  record,
  onSaved,
  onStale,
}: Props) {
  const editing = record !== undefined;
  const [baseline, setBaseline] = useState<FormValues>(
    record === undefined ? EMPTY : toValues(record),
  );
  const [values, setValues] = useState<FormValues>(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<readonly string[]>([]);
  const [outcome, setOutcome] = useState<string | null>(null);

  // Editing is an OPEN-only affordance, exactly as reviewing is a SUBMITTED-
  // only one. Guarded here as well as by the caller: a form on a terminal
  // record can only produce a doomed request.
  if (record !== undefined && record.status !== 'OPEN') {
    return null;
  }

  const idPrefix = editing ? `maintenance-${record.id}` : 'maintenance-new';

  const set = <K extends keyof FormValues>(key: K, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  /**
   * Validates the three typed fields and returns them in wire form. Null
   * means a message has already been shown and no request should be made.
   */
  const readFields = (): {
    startedAt: string;
    odometer: number | null;
    cost: string | null;
  } | null => {
    // A datetime-local input carries no zone, so the value is read as Manila
    // wall-clock and converted explicitly, exactly as trip schedules are.
    const startedAt = manilaLocalToIso(values.startedAt);
    if (startedAt === null) {
      setError(STARTED_INVALID);
      return null;
    }
    const typedOdometer = values.odometer;
    if (typedOdometer !== '' && !ODOMETER_PATTERN.test(typedOdometer)) {
      // `1.5`, `-1` and `1e3` are refused rather than silently coerced.
      setError(ODOMETER_INVALID);
      return null;
    }
    const typedCost = values.cost;
    if (typedCost !== '' && !isValidMaintenanceCostInput(typedCost)) {
      setError(COST_INVALID);
      return null;
    }
    return {
      startedAt,
      // Only the odometer becomes a number: it is a count, not money.
      odometer: typedOdometer === '' ? null : Number(typedOdometer),
      // The cost stays the exact string that was typed.
      cost: typedCost === '' ? null : typedCost,
    };
  };

  /** Just the fields whose text differs from the stored record. */
  const buildPatch = (fields: {
    startedAt: string;
    odometer: number | null;
    cost: string | null;
  }): UpdateMaintenanceInput => {
    const patch: {
      category?: CreateMaintenanceInput['category'];
      startedAt?: string;
      description?: string;
      odometer?: number | null;
      cost?: string | null;
    } = {};
    if (values.category !== baseline.category) {
      patch.category = values.category as CreateMaintenanceInput['category'];
    }
    // Compared as the wall-clock text, not as instants: a stored second would
    // otherwise make an untouched field look edited on every save.
    if (values.startedAt !== baseline.startedAt) {
      patch.startedAt = fields.startedAt;
    }
    if (values.description !== baseline.description) {
      patch.description = values.description;
    }
    if (values.odometer !== baseline.odometer) {
      patch.odometer = fields.odometer;
    }
    if (values.cost !== baseline.cost) {
      patch.cost = fields.cost;
    }
    return patch;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setDetails([]);
    setOutcome(null);

    const fields = readFields();
    if (fields === null) {
      return;
    }

    if (editing) {
      const patch = buildPatch(fields);
      if (Object.keys(patch).length === 0) {
        // The API refuses an empty patch, and a round trip to be told so is
        // worse than saying it immediately.
        setOutcome(UNCHANGED);
        return;
      }
      setBusy(true);
      const result = await updateMaintenance(record.id, patch);
      setBusy(false);
      if (!result.ok) {
        setError(adminErrorMessage(result));
        setDetails(result.validationMessages ?? []);
        if (result.code === 'maintenance_not_editable') {
          // Someone else finished or cancelled it. Leaving an edit form on a
          // terminal record invites a second doomed attempt, so ask the
          // parent for the real state rather than guessing at it here.
          onStale();
        }
        return;
      }
      // Re-baselined from the authoritative row, never a local merge.
      const saved = toValues(result.data);
      setBaseline(saved);
      setValues(saved);
      setOutcome(UPDATED);
      onSaved(result.data);
      return;
    }

    const input: CreateMaintenanceInput = {
      category: values.category as CreateMaintenanceInput['category'],
      startedAt: fields.startedAt,
      description: values.description,
      // Omitted rather than nulled when blank: there is nothing to clear on a
      // record that does not exist yet.
      ...(fields.odometer === null ? {} : { odometer: fields.odometer }),
      ...(fields.cost === null ? {} : { cost: fields.cost }),
    };

    setBusy(true);
    const result = await createVehicleMaintenance(vehicleId, input);
    setBusy(false);
    if (!result.ok) {
      // Typed values stay put so nothing has to be re-entered.
      setError(adminErrorMessage(result));
      setDetails(result.validationMessages ?? []);
      return;
    }
    setValues(EMPTY);
    setBaseline(EMPTY);
    setOutcome(CREATED);
    onSaved(result.data);
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h4>{editing ? 'Edit maintenance' : 'Add maintenance'}</h4>
      <p>
        <label htmlFor={`${idPrefix}-category`}>Category</label>
        <br />
        <select
          id={`${idPrefix}-category`}
          name="category"
          value={values.category}
          onChange={(event) => set('category', event.target.value)}
        >
          {MAINTENANCE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </p>
      <p>
        <label htmlFor={`${idPrefix}-started-at`}>
          Started at (Asia/Manila)
        </label>
        <br />
        <input
          id={`${idPrefix}-started-at`}
          name="startedAt"
          type="datetime-local"
          value={values.startedAt}
          required
          onChange={(event) => set('startedAt', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor={`${idPrefix}-description`}>Description</label>
        <br />
        <textarea
          id={`${idPrefix}-description`}
          name="description"
          value={values.description}
          maxLength={DESCRIPTION_MAX_LENGTH}
          rows={3}
          onChange={(event) => set('description', event.target.value)}
        />
      </p>
      <p>
        <label htmlFor={`${idPrefix}-odometer`}>Odometer</label>
        <br />
        <input
          id={`${idPrefix}-odometer`}
          name="odometer"
          type="text"
          inputMode="numeric"
          value={values.odometer}
          onChange={(event) => set('odometer', event.target.value)}
        />
        <br />
        <small>Whole number. Leave blank if none was recorded.</small>
      </p>
      <p>
        <label htmlFor={`${idPrefix}-cost`}>Cost (PHP)</label>
        <br />
        <input
          id={`${idPrefix}-cost`}
          name="cost"
          type="text"
          inputMode="decimal"
          value={values.cost}
          maxLength={COST_MAX_LENGTH}
          pattern={COST_PATTERN}
          onChange={(event) => set('cost', event.target.value)}
        />
        <br />
        <small>Leave blank if no cost was recorded. Zero is valid.</small>
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
          {editing ? 'Save changes' : 'Add maintenance'}
        </button>
      </p>
    </form>
  );
}
