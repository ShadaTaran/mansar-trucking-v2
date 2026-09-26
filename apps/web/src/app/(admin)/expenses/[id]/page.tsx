import type { Metadata } from 'next';

import { ExpenseDetail } from '@/components/expense-detail';

export const metadata: Metadata = { title: 'Expense — Mansar Trucking' };

/**
 * There is no /expenses/new: an expense only exists against a trip, and the
 * API creates one at POST /trips/:tripId/expenses, so admin entry lives on
 * the trip page where the trip is already in hand.
 */
export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ExpenseDetail expenseId={id} />;
}
