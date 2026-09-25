import type { Expense, Page } from '@mansar/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type CreateExpenseBody,
  createExpenseSchema,
  type ListDriverExpensesQuery,
  listDriverExpensesSchema,
  tripIdParamSchema,
} from './expenses.schemas.js';
import { ExpensesService } from './expenses.service.js';

/**
 * A driver's expenses on one of their own trips (Stage 6B). DRIVER only for
 * the whole controller: an ADMIN gets 403 here and uses `/expenses` and
 * `/trips/:tripId/expenses` instead.
 *
 * The trip must belong to the operational driver linked to the authenticated
 * login; no route accepts a driver id. A trip owned by someone else reads as
 * absent rather than as forbidden.
 */
@Roles('DRIVER')
@Controller('driver/trips/:tripId/expenses')
export class DriverTripExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(
    @Param('tripId', { schema: tripIdParamSchema }) tripId: string,
    @Query({ schema: listDriverExpensesSchema })
    query: ListDriverExpensesQuery,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<Page<Expense>> {
    return this.expenses.listForDriver({ actor, tripId, query });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('tripId', { schema: tripIdParamSchema }) tripId: string,
    @Body({ schema: createExpenseSchema }) body: CreateExpenseBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Expense> {
    return this.expenses.createForOwnTrip({ actor, tripId, body, requestId });
  }
}
