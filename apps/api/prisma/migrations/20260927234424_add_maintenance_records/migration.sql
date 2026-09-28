-- CreateEnum
CREATE TYPE "maintenance_status" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "maintenance_category" AS ENUM ('PREVENTIVE', 'REPAIR', 'INSPECTION', 'TIRE', 'OTHER');

-- CreateTable
CREATE TABLE "maintenance_records" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "maintenance_status" NOT NULL DEFAULT 'OPEN',
    "category" "maintenance_category" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "odometer" INTEGER,
    "cost" DECIMAL(12,2),
    "description" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "maintenance_records_vehicle_id_started_at_id_idx" ON "maintenance_records"("vehicle_id", "started_at", "id");

-- CreateIndex
CREATE INDEX "maintenance_records_status_started_at_id_idx" ON "maintenance_records"("status", "started_at", "id");

-- AddForeignKey
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Hand-extended section (docs/database.md §15).
--
-- These PostgreSQL-native invariants cannot be expressed in the Prisma schema
-- and are invisible to `db:diff:check`, so
-- `test/maintenance-persistence.int-spec.ts` asserts every one of them against
-- a real database. Names are explicit and stable.
--
-- They protect row consistency only. The OPEN -> terminal transition rules,
-- post-completion immutability, the description ceiling and the decimal input
-- shape are API semantics (Stage 7B.3), not column constraints, and
-- `Vehicle.status` is deliberately unrelated to any row here (ADR 0010).
-- ---------------------------------------------------------------------------

-- Completed exactly when the work is. A COMPLETED row with no completion
-- instant, or an OPEN or CANCELLED row claiming one, describes a state that
-- has no meaning. This mirrors `expenses_review_consistency`.
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_completion_consistency" CHECK (
    (
        "status" = 'COMPLETED'
        AND "completed_at" IS NOT NULL
    )
    OR (
        "status" IN ('OPEN', 'CANCELLED')
        AND "completed_at" IS NULL
    )
);

-- Work cannot finish before it began. Equality is allowed, for a job treated
-- as instantaneous. Only a complete pair is constrained, so an OPEN row with
-- no completion instant is unaffected.
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_completion_order" CHECK (
    "completed_at" IS NULL
    OR "completed_at" >= "started_at"
);

-- A reading is never negative. INTEGER already bounds the magnitude and
-- excludes a fractional value; this bounds the sign. Absent is legitimate:
-- not every job records the odometer. Deliberately no monotonic rule — a
-- lower historical reading is a correction, not a violation.
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_odometer_non_negative" CHECK (
    "odometer" IS NULL
    OR "odometer" >= 0
);

-- A cost is never negative. Unlike `expenses_amount_positive`, zero is
-- permitted here: warranty and goodwill work legitimately costs nothing.
-- NULL means no cost was recorded, which is not the same as free.
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_cost_non_negative" CHECK (
    "cost" IS NULL
    OR "cost" >= 0
);
