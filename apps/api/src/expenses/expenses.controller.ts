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
  type ApproveExpenseBody,
  approveExpenseSchema,
  expenseIdSchema,
  type ListExpensesQuery,
  listExpensesSchema,
  type RejectExpenseBody,
  rejectExpenseSchema,
} from './expenses.schemas.js';
import { ExpensesService } from './expenses.service.js';

/**
 * Admin review of expenses (Stage 6B). ADMIN only for the whole controller.
 *
 * There is no delete route and no edit route: a submitted expense is
 * immutable, and a mistake is corrected by rejecting it and filing a new one
 * so the incorrect record survives as history. Creation lives on
 * `/trips/:tripId/expenses`, because an expense only exists against a trip.
 */
@Roles('ADMIN')
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  list(
    @Query({ schema: listExpensesSchema }) query: ListExpensesQuery,
  ): Promise<Page<Expense>> {
    return this.expenses.list(query);
  }

  @Get(':id')
  getOne(
    @Param('id', { schema: expenseIdSchema }) expenseId: string,
  ): Promise<Expense> {
    return this.expenses.getOne(expenseId);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Param('id', { schema: expenseIdSchema }) expenseId: string,
    @Body({ schema: approveExpenseSchema }) body: ApproveExpenseBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Expense> {
    return this.expenses.approve({
      actor,
      expenseId,
      reviewNote: body.reviewNote,
      requestId,
    });
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id', { schema: expenseIdSchema }) expenseId: string,
    @Body({ schema: rejectExpenseSchema }) body: RejectExpenseBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Expense> {
    return this.expenses.reject({
      actor,
      expenseId,
      reviewNote: body.reviewNote,
      requestId,
    });
  }
}
