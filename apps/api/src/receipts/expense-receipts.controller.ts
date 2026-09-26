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
 * The receipt attached to one expense (Stage 6D). ADMIN only for the whole
 * controller.
 *
 * Every route hangs off the expense, because a receipt has no independent
 * existence: there is no `/receipts/:receiptId`, and no request anywhere
 * accepts a receipt id. A caller that could name a receipt directly could
 * probe for other expenses' receipts, and the expense route already carries
 * the authorization the receipt inherits.
 *
 * There is no delete route. Stage 6 removes nothing — an incorrect receipt
 * is superseded by rejecting the expense and filing a new one, so the
 * incorrect record survives as history, and the storage credential needs no
 * delete permission at all (ADR 0009).
 *
 * `GET /:id/receipt` and `POST /:id/receipt/read-authorization` stay
 * separate on purpose. Reading metadata must not depend on the object store
 * being reachable, and must not mint a bearer capability as a side effect of
 * a plain GET.
 */
@Roles('ADMIN')
@Controller('expenses')
export class ExpenseReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  /**
   * 200, not 201: this is create-or-reissue. A retry against an existing
   * pending receipt creates nothing, and answering 201 would tell the client
   * a new resource appeared when the same one was handed back.
   */
  @Post(':id/receipt/upload-intent')
  @HttpCode(HttpStatus.OK)
  uploadIntent(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @Body({ schema: uploadIntentSchema }) body: UploadIntentBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<ReceiptUploadAuthorization> {
    return this.receipts.createUploadIntent({
      actor,
      expenseId,
      body,
      requestId,
    });
  }

  /**
   * No body: the server already knows what it authorized.
   *
   * The empty-body schema is bound rather than the parameter simply being
   * omitted. Without it Nest never reads the body, so anything sent would be
   * accepted and discarded — and a client could believe it was passing an
   * override the server was quietly ignoring. The parsed value is unused by
   * design; it exists so the validation pipe runs.
   */
  @Post(':id/receipt/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
    @Body({ schema: emptyBodySchema }) _body: EmptyBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Receipt> {
    return this.receipts.confirm({ actor, expenseId, requestId });
  }

  @Get(':id/receipt')
  getOne(
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
  ): Promise<Receipt> {
    return this.receipts.getMetadata({ expenseId });
  }

  /**
   * A POST, though it reads: it mints a short-lived bearer capability, which
   * is a side effect a GET should not have — and one that must never be
   * cached or turn up in a browser history.
   */
  @Post(':id/receipt/read-authorization')
  @HttpCode(HttpStatus.OK)
  readAuthorization(
    // Deliberately first. Nest resolves parameters by decorator, not by
    // position, and the lint rule only reports an unused argument that
    // follows the last used one — so an intentionally unused body has to sit
    // ahead of the parameter this handler actually reads.
    @Body({ schema: emptyBodySchema }) _body: EmptyBody,
    @Param('id', { schema: receiptExpenseIdSchema }) expenseId: string,
  ): Promise<ReceiptReadAuthorization> {
    return this.receipts.createReadAuthorization({ expenseId });
  }
}
