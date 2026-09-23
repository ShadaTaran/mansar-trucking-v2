-- CreateEnum
CREATE TYPE "trip_status" AS ENUM ('DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "trips" (
    "id" UUID NOT NULL,
    "status" "trip_status" NOT NULL DEFAULT 'DRAFT',
    "driver_id" UUID,
    "vehicle_id" UUID,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "scheduled_start_at" TIMESTAMPTZ(3),
    "scheduled_end_at" TIMESTAMPTZ(3),
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trips_status_scheduled_start_at_id_idx" ON "trips"("status", "scheduled_start_at", "id");

-- CreateIndex
CREATE INDEX "trips_driver_id_scheduled_start_at_id_idx" ON "trips"("driver_id", "scheduled_start_at", "id");

-- CreateIndex
CREATE INDEX "trips_vehicle_id_scheduled_start_at_id_idx" ON "trips"("vehicle_id", "scheduled_start_at", "id");

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Hand-extended section (docs/database.md §15).
--
-- These PostgreSQL-native objects cannot be expressed in the Prisma schema and
-- are invisible to `db:diff:check`, so `test/trips-persistence.int-spec.ts`
-- asserts every one of them against a real database. Names are explicit and
-- stable because the API maps violations back to domain errors.
-- ---------------------------------------------------------------------------

-- Required by the GiST exclusion constraints below: `btree_gist` is what lets
-- a plain-equality column (driver_id / vehicle_id) share a GiST index with a
-- range column.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A scheduled window is ordered. Either bound may still be absent (a DRAFT
-- trip carries no schedule yet); only a complete window is constrained.
ALTER TABLE "trips" ADD CONSTRAINT "trips_schedule_order" CHECK (
    "scheduled_start_at" IS NULL
    OR "scheduled_end_at" IS NULL
    OR "scheduled_end_at" > "scheduled_start_at"
);

-- Past DRAFT and CANCELLED, a trip carries a complete assignment. This also
-- guards the exclusion constraints: `tstzrange(NULL, NULL)` is the UNBOUNDED
-- range in PostgreSQL, so a participating row with an absent window would
-- overlap every other row of the same driver or vehicle.
ALTER TABLE "trips" ADD CONSTRAINT "trips_assignment_complete" CHECK (
    "status" IN ('DRAFT', 'CANCELLED')
    OR (
        "driver_id" IS NOT NULL
        AND "vehicle_id" IS NOT NULL
        AND "scheduled_start_at" IS NOT NULL
        AND "scheduled_end_at" IS NOT NULL
    )
);

-- One driver cannot hold two overlapping scheduled windows. The range is
-- half-open `[start, end)`, so a trip ending at 12:00 and one starting at
-- 12:00 are back-to-back, not overlapping. DRAFT and CANCELLED trips do not
-- participate, so planning and cancelling never reserve a driver.
ALTER TABLE "trips" ADD CONSTRAINT "trips_driver_schedule_excl" EXCLUDE USING gist (
    "driver_id" WITH =,
    tstzrange("scheduled_start_at", "scheduled_end_at", '[)') WITH &&
) WHERE ("status" IN ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED'));

-- The same invariant for a vehicle.
ALTER TABLE "trips" ADD CONSTRAINT "trips_vehicle_schedule_excl" EXCLUDE USING gist (
    "vehicle_id" WITH =,
    tstzrange("scheduled_start_at", "scheduled_end_at", '[)') WITH &&
) WHERE ("status" IN ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED'));

-- At most one running trip per driver and per vehicle, independent of the
-- scheduled windows: a second IN_PROGRESS trip is rejected even when its
-- window does not overlap.
CREATE UNIQUE INDEX "trips_one_in_progress_per_driver"
    ON "trips" ("driver_id") WHERE "status" = 'IN_PROGRESS';

CREATE UNIQUE INDEX "trips_one_in_progress_per_vehicle"
    ON "trips" ("vehicle_id") WHERE "status" = 'IN_PROGRESS';
