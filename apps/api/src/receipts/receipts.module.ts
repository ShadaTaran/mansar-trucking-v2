import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DriverExpenseReceiptsController } from './driver-expense-receipts.controller.js';
import { ExpenseReceiptsController } from './expense-receipts.controller.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * Receipts (Stage 6D). One service behind two controllers, one per role:
 * `/expenses/:id/receipt/…` for ADMIN and `/driver/expenses/:id/receipt/…`
 * for the driver who incurred the cost.
 *
 * Deliberately does **not** import ExpensesModule. This service reads and
 * locks expense and driver rows through Prisma directly, exactly as
 * ExpensesService reads and locks trip rows, so the two modules stay
 * independent and no circular dependency can form. Nothing in expenses needs
 * anything from here either: trip verification is decided by expense state
 * alone and never queries a receipt.
 */
@Module({
  imports: [DatabaseModule, AuditModule, StorageModule],
  controllers: [ExpenseReceiptsController, DriverExpenseReceiptsController],
  providers: [ReceiptsService],
  exports: [ReceiptsService],
})
export class ReceiptsModule {}
