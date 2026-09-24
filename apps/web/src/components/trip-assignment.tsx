'use client';

import type { Driver, Trip, Vehicle } from '@mansar/types';
import { type FormEvent, useEffect, useState } from 'react';

import {
  adminErrorMessage,
  assignTrip,
  getDriver,
  getVehicle,
  listDrivers,
  listVehicles,
} from '@/lib/client/admin-api';
import {
  isoToManilaLocal,
  MANILA_LABEL,
  manilaLocalToIso,
} from '@/lib/trip-time';

/** One page of candidates is plenty for a submit-based search. */
const CANDIDATE_PAGE_SIZE = 100;

interface Props {
  readonly trip: Trip;
  readonly onChanged: (trip: Trip) => void;
}

const driverLabel = (driver: Driver): string =>
  `${driver.fullName} — ${driver.licenceNumber}${
    driver.status === 'ACTIVE' ? '' : ` — ${driver.status}`
  }`;

const vehicleLabel = (vehicle: Vehicle): string =>
  `${vehicle.plateNumber} — ${vehicle.make} ${vehicle.model}${
    vehicle.status === 'ACTIVE' ? '' : ` — ${vehicle.status}`
  }`;

/**
 * Merges the currently assigned record into the ACTIVE candidates.
 *
 * The driver or vehicle a trip already holds may have been deactivated or
 * retired since it was assigned, in which case it is absent from an ACTIVE
 * search and the select would silently lose its own value. It is added back
 * so the admin can see what is assigned — its label carries the real status —
 * but it is never treated as a valid choice for a new assignment.
 */
function withCurrent<T extends { readonly id: string }>(
  options: readonly T[],
  current: T | null,
): readonly T[] {
  if (current === null || options.some((option) => option.id === current.id)) {
    return options;
  }
  return [current, ...options];
}

/**
 * Assign, reassign or reschedule a trip.
 *
 * Only offered while a trip is DRAFT or ASSIGNED — TripDetail decides that.
 * Candidates come from the existing ADMIN drivers and vehicles listings,
 * filtered to ACTIVE; nothing here caches a judgement about availability,
 * because a resource can change state between the search and the submit and
 * the API is the authority on that.
 */
export function TripAssignment({ trip, onChanged }: Props) {
  const [driverQuery, setDriverQuery] = useState('');
  const [vehicleQuery, setVehicleQuery] = useState('');
  const [driverSearch, setDriverSearch] = useState('');
  const [vehicleSearch, setVehicleSearch] = useState('');
  const [drivers, setDrivers] = useState<readonly Driver[]>([]);
  const [vehicles, setVehicles] = useState<readonly Vehicle[]>([]);
  const [currentDriver, setCurrentDriver] = useState<Driver | null>(null);
  const [currentVehicle, setCurrentVehicle] = useState<Vehicle | null>(null);

  const [driverId, setDriverId] = useState(trip.driverId ?? '');
  const [vehicleId, setVehicleId] = useState(trip.vehicleId ?? '');
  const [start, setStart] = useState(
    trip.scheduledStartAt === null
      ? ''
      : (isoToManilaLocal(trip.scheduledStartAt) ?? ''),
  );
  const [end, setEnd] = useState(
    trip.scheduledEndAt === null
      ? ''
      : (isoToManilaLocal(trip.scheduledEndAt) ?? ''),
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listDrivers({
        q: driverSearch,
        status: 'ACTIVE',
        page: 1,
        pageSize: CANDIDATE_PAGE_SIZE,
      });
      if (!cancelled && result.ok) {
        setDrivers(result.data.items);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driverSearch]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await listVehicles({
        q: vehicleSearch,
        status: 'ACTIVE',
        page: 1,
        pageSize: CANDIDATE_PAGE_SIZE,
      });
      if (!cancelled && result.ok) {
        setVehicles(result.data.items);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vehicleSearch]);

  const assignedDriverId = trip.driverId;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (assignedDriverId === null) {
        if (!cancelled) {
          setCurrentDriver(null);
        }
        return;
      }
      const result = await getDriver(assignedDriverId);
      if (!cancelled && result.ok) {
        setCurrentDriver(result.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignedDriverId]);

  const assignedVehicleId = trip.vehicleId;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (assignedVehicleId === null) {
        if (!cancelled) {
          setCurrentVehicle(null);
        }
        return;
      }
      const result = await getVehicle(assignedVehicleId);
      if (!cancelled && result.ok) {
        setCurrentVehicle(result.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignedVehicleId]);

  const driverOptions = withCurrent(drivers, currentDriver);
  const vehicleOptions = withCurrent(vehicles, currentVehicle);
  const chosenDriver = driverOptions.find((item) => item.id === driverId);
  const chosenVehicle = vehicleOptions.find((item) => item.id === vehicleId);
  const reassigning = trip.status === 'ASSIGNED';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setOutcome(null);

    if (driverId === '' || vehicleId === '') {
      setError('Choose a driver and a vehicle.');
      return;
    }
    // A stale selection is only rejected when we positively know it is not
    // ACTIVE; everything else is left to the API.
    if (chosenDriver && chosenDriver.status !== 'ACTIVE') {
      setError('Select an active driver before assigning this trip.');
      return;
    }
    if (chosenVehicle && chosenVehicle.status !== 'ACTIVE') {
      setError('Select an active vehicle before assigning this trip.');
      return;
    }

    const scheduledStartAt = manilaLocalToIso(start);
    const scheduledEndAt = manilaLocalToIso(end);
    if (scheduledStartAt === null || scheduledEndAt === null) {
      setError('Enter a valid scheduled start and end.');
      return;
    }
    if (Date.parse(scheduledEndAt) <= Date.parse(scheduledStartAt)) {
      setError('Scheduled end must be after scheduled start.');
      return;
    }

    setBusy(true);
    const result = await assignTrip(trip.id, {
      driverId,
      vehicleId,
      scheduledStartAt,
      scheduledEndAt,
    });
    if (!result.ok) {
      setError(adminErrorMessage(result));
      setBusy(false);
      return;
    }
    // The response is authoritative; local values are replaced from it.
    setDriverId(result.data.driverId ?? '');
    setVehicleId(result.data.vehicleId ?? '');
    setStart(
      result.data.scheduledStartAt === null
        ? ''
        : (isoToManilaLocal(result.data.scheduledStartAt) ?? ''),
    );
    setEnd(
      result.data.scheduledEndAt === null
        ? ''
        : (isoToManilaLocal(result.data.scheduledEndAt) ?? ''),
    );
    setOutcome('Assignment saved.');
    setBusy(false);
    onChanged(result.data);
  };

  return (
    <section aria-labelledby="trip-assignment-heading">
      <h2 id="trip-assignment-heading">Assignment</h2>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setDriverSearch(driverQuery);
        }}
      >
        <label htmlFor="trip-driver-search">Search drivers</label>{' '}
        <input
          id="trip-driver-search"
          name="driverQuery"
          value={driverQuery}
          onChange={(event) => setDriverQuery(event.target.value)}
          placeholder="Name, phone or licence"
        />{' '}
        <button type="submit" disabled={busy}>
          Search drivers
        </button>
      </form>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setVehicleSearch(vehicleQuery);
        }}
      >
        <label htmlFor="trip-vehicle-search">Search vehicles</label>{' '}
        <input
          id="trip-vehicle-search"
          name="vehicleQuery"
          value={vehicleQuery}
          onChange={(event) => setVehicleQuery(event.target.value)}
          placeholder="Plate, make or model"
        />{' '}
        <button type="submit" disabled={busy}>
          Search vehicles
        </button>
      </form>

      <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
        <p>
          <label htmlFor="trip-driver">Driver</label>
          <br />
          <select
            id="trip-driver"
            name="driverId"
            value={driverId}
            required
            disabled={busy}
            onChange={(event) => setDriverId(event.target.value)}
          >
            <option value="">Select a driver</option>
            {driverOptions.map((driver) => (
              <option key={driver.id} value={driver.id}>
                {driverLabel(driver)}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="trip-vehicle">Vehicle</label>
          <br />
          <select
            id="trip-vehicle"
            name="vehicleId"
            value={vehicleId}
            required
            disabled={busy}
            onChange={(event) => setVehicleId(event.target.value)}
          >
            <option value="">Select a vehicle</option>
            {vehicleOptions.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicleLabel(vehicle)}
              </option>
            ))}
          </select>
        </p>
        <p>
          <label htmlFor="trip-scheduled-start">
            Scheduled start ({MANILA_LABEL} time)
          </label>
          <br />
          <input
            id="trip-scheduled-start"
            name="scheduledStartAt"
            type="datetime-local"
            value={start}
            required
            disabled={busy}
            onChange={(event) => setStart(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="trip-scheduled-end">
            Scheduled end ({MANILA_LABEL} time)
          </label>
          <br />
          <input
            id="trip-scheduled-end"
            name="scheduledEndAt"
            type="datetime-local"
            value={end}
            required
            disabled={busy}
            onChange={(event) => setEnd(event.target.value)}
          />
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {outcome ? <p role="status">{outcome}</p> : null}
        <p>
          <button type="submit" disabled={busy}>
            {reassigning ? 'Reassign / reschedule' : 'Assign trip'}
          </button>
        </p>
      </form>
    </section>
  );
}
