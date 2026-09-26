import type {
  Receipt,
  ReceiptReadAuthorization,
  ReceiptUploadAuthorization,
} from '@mansar/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type EmptyBody,
  emptyBodySchema,
  receiptExpenseIdSchema,
  type UploadIntentBody,
  uploadIntentSchema,
} from './receipts.schemas.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * The same four operations for the driver who incurred the cost (Stage 6D).
 * DRIVER only for the whole controller.
 *
 * The scope is always the authenticated login's own operational driver,
 * resolved server-side: no route, body or query here accepts a driver id.
 * An expense on someone else's trip answers `expense_not_found`, exactly as
 * a non-existent id does, so the API never reveals that another driver's
 * expense exists.
 *
 * A driver may attach and confirm a receipt, and read their own back. They
 * cannot approve, reject or delete anything: every one of those is an
 * administrative action.
 */
@Roles('DRIVER')
@Controller('driver/expenses')
export class DriverExpenseReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /** 200, not 201: create-or-reissue, exactly as on the admin route. */
  @Post(':id/receipt/upload-intent')
  @HttpCode(HttpStatus.OK)
  uploadIntent(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @Body({ schema: uploadIntentSchema }) body: UploadIntentBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<ReceiptUploadAuthorization> {
    return this.receipts.createUploadIntentForOwn({
      actor,
      expenseId,
      body,
      requestId,
    });
  }

  /** No body, enforced by the same schema the admin route binds. */
  @Post(':id/receipt/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @Body({ schema: emptyBodySchema }) _body: EmptyBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Receipt> {
    return this.receipts.confirmForOwn({ actor, expenseId, requestId });
  }

  @Get(':id/receipt')
  getOne(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<Receipt> {
    return this.receipts.getMetadataForOwn({ actor, expenseId });
  }

  @Post(':id/receipt/read-authorization')
  @HttpCode(HttpStatus.OK)
  readAuthorization(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @Body({ schema: emptyBodySchema }) _body: EmptyBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<ReceiptReadAuthorization> {
    return this.receipts.createReadAuthorizationForOwn({ actor, expenseId });
  }
}
