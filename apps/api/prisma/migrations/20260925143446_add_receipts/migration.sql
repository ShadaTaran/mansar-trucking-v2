-- CreateTable
CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipts_expense_id_key" ON "receipts"("expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_object_key_key" ON "receipts"("object_key");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Hand-extended section (docs/database.md §15).
--
-- These PostgreSQL-native invariants cannot be expressed in the Prisma schema
-- and are invisible to `db:diff:check`, so
-- `test/receipts-persistence.int-spec.ts` asserts every one of them against a
-- real database. Names are explicit and stable.
-- ---------------------------------------------------------------------------

-- The frozen Stage 6 size window, in bytes: at least one byte, at most
-- 10 MiB. A zero-byte receipt is not a photograph of anything, and the upper
-- bound is the same ceiling the upload policy signs, so a row can never
-- claim a size the store would have refused. INTEGER already bounds the
-- magnitude and excludes a fractional value; this bounds the range.
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_byte_size_range" CHECK (
    "byte_size" >= 1
    AND "byte_size" <= 10485760
);

-- Exactly the three frozen image types, in their normalized form: lower
-- case, no parameters. Widening this set is a deliberate migration rather
-- than a config change, which is the correct cost — the allowed types are a
-- business decision about what a receipt may be, and the upload policy signs
-- this value, so the database and the store must agree on it exactly.
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_content_type_allowed" CHECK (
    "content_type" IN (
        'image/jpeg',
        'image/png',
        'image/webp'
    )
);
