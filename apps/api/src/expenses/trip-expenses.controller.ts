import type { Expense } from '@mansar/types';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type CreateExpenseBody,
  createExpenseSchema,
  tripIdParamSchema,
} from './expenses.schemas.js';
import { ExpensesService } from './expenses.service.js';

/**
 * ADMIN-on-behalf expense entry (Stage 6B): the office filing post-trip
 * paperwork that reached a desk rather than the driver app.
 *
 * Only legal once the trip is COMPLETED. The result is an ordinary
 * SUBMITTED expense — filing one is not reviewing it, so the same admin must
 * still approve or reject it through the normal lifecycle. The submitting
 * identity is the audit row's actor; the expense stores no submitter.
 */
@Roles('ADMIN')
@Controller('trips/:tripId/expenses')
export class TripExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('tripId', { schema: tripIdParamSchema }) tripId: string,
    @Body({ schema: createExpenseSchema }) body: CreateExpenseBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Expense> {
    return this.expenses.createForTrip({ actor, tripId, body, requestId });
  }
}
