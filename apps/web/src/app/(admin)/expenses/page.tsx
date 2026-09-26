import type { Metadata } from 'next';

import { ExpensesList } from '@/components/expenses-list';

export const metadata: Metadata = { title: 'Expenses — Mansar Trucking' };

/** Protected by the (admin) layout; data comes from the BFF proxy. */
export default function ExpensesPage() {
  return <ExpensesList />;
}
