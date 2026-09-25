-- CreateEnum
CREATE TYPE "expense_status" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "expense_category" AS ENUM ('FUEL', 'TOLL', 'PARKING', 'MEAL', 'REPAIR', 'OTHER');

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "status" "expense_status" NOT NULL DEFAULT 'SUBMITTED',
    "amount" DECIMAL(12,2) NOT NULL,
    "category" "expense_category" NOT NULL,
    "incurred_at" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "review_note" TEXT NOT NULL DEFAULT '',
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expenses_status_incurred_at_id_idx" ON "expenses"("status", "incurred_at", "id");

-- CreateIndex
CREATE INDEX "expenses_trip_id_incurred_at_id_idx" ON "expenses"("trip_id", "incurred_at", "id");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Hand-extended section (docs/database.md §15).
--
-- These PostgreSQL-native invariants cannot be expressed in the Prisma schema
-- and are invisible to `db:diff:check`, so
-- `test/expenses-persistence.int-spec.ts` asserts every one of them against a
-- real database. Names are explicit and stable.
-- ---------------------------------------------------------------------------

-- A cost of nothing, or of a negative amount, is not a cost. The column is
-- NUMERIC(12,2), which bounds the magnitude and the scale; this bounds the
-- sign.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amount_positive" CHECK (
    "amount" > 0
);

-- Reviewed exactly when no longer SUBMITTED. Without this, an APPROVED row
-- could carry no decision instant, or a SUBMITTED row could claim one, and
-- neither state has a meaning.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_review_consistency" CHECK (
    (
        "status" = 'SUBMITTED'
        AND "reviewed_at" IS NULL
    )
    OR (
        "status" <> 'SUBMITTED'
        AND "reviewed_at" IS NOT NULL
    )
);

-- A rejection always says why: the submitter's only feedback is this note,
-- so an empty one would leave them with nothing to correct. Whitespace is
-- not a reason either, and the test must say so precisely: single-argument
-- `btrim` removes spaces and nothing else, so a tab- or newline-only note
-- would slip past it. Requiring one character outside the POSIX `space`
-- class covers spaces, tabs, newlines, carriage returns, vertical tabs and
-- form feeds in a single condition.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_rejection_requires_note" CHECK (
    "status" <> 'REJECTED'
    OR "review_note" ~ '[^[:space:]]'
);
