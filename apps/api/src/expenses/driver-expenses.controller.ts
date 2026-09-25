import type { Expense } from '@mansar/types';
import { Controller, Get, Param } from '@nestjs/common';

import { CurrentUser, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import { expenseIdSchema } from './expenses.schemas.js';
import { ExpensesService } from './expenses.service.js';

/**
 * One of the authenticated driver's own expenses, by id (Stage 6B).
 *
 * Read only. A driver cannot approve, reject, edit or delete: every one of
 * those is an administrative action. An expense on someone else's trip reads
 * as `expense_not_found`, exactly as a non-existent id does, so the API
 * never reveals that another driver's expense exists.
 */
@Roles('DRIVER')
@Controller('driver/expenses')
export class DriverExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get(':id')
  getOne(
    @Param('id', { schema: expenseIdSchema }) expenseId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<Expense> {
    return this.expenses.getOneForDriver({ actor, expenseId });
  }
}
