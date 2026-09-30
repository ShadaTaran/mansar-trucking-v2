-- CreateTable
CREATE TABLE "trip_location_samples" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "sample_id" UUID NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_location_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trip_location_samples_sample_id_key" ON "trip_location_samples"("sample_id");

-- CreateIndex
CREATE INDEX "trip_location_samples_trip_id_recorded_at_id_idx" ON "trip_location_samples"("trip_id", "recorded_at", "id");

-- AddForeignKey
ALTER TABLE "trip_location_samples" ADD CONSTRAINT "trip_location_samples_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Hand-written PostgreSQL invariants below this line (docs/database.md §15).
-- `db:diff:check` cannot see them, so test/location-persistence.int-spec.ts
-- asserts each one by name against a real database.

-- A latitude outside the poles is not a position. The bound also rejects the
-- non-finite doubles PostgreSQL would otherwise accept in this column:
-- 'NaN' and 'Infinity' both compare false against BETWEEN, so neither can be
-- stored. Request validation refuses them one layer earlier as well.
ALTER TABLE "trip_location_samples" ADD CONSTRAINT "trip_location_samples_latitude_range" CHECK (
    "latitude" BETWEEN -90 AND 90
);

-- The same, for the antimeridian. Both bounds are inclusive: -180 and 180 name
-- the same meridian and a device may report either.
ALTER TABLE "trip_location_samples" ADD CONSTRAINT "trip_location_samples_longitude_range" CHECK (
    "longitude" BETWEEN -180 AND 180
);

-- Horizontal accuracy is a radius, so it is never negative. NULL means the
-- device reported none, which is not the same as a perfect fix. Deliberately
-- no upper bound: how coarse a fix is too coarse to keep is a capture policy
-- the mobile tracker applies, not a persistence invariant.
ALTER TABLE "trip_location_samples" ADD CONSTRAINT "trip_location_samples_accuracy_non_negative" CHECK (
    "accuracy" IS NULL
    OR "accuracy" >= 0
);
