import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DriverExpensesController } from './driver-expenses.controller.js';
import { DriverTripExpensesController } from './driver-trip-expenses.controller.js';
import { ExpensesController } from './expenses.controller.js';
import { ExpensesService } from './expenses.service.js';
import { TripExpensesController } from './trip-expenses.controller.js';

/**
 * Expenses (Stage 6B). One service behind four controllers, one per path
 * prefix and role: `/expenses` and `/trips/:tripId/expenses` for ADMIN,
 * `/driver/expenses` and `/driver/trips/:tripId/expenses` for the driver who
 * incurred the cost.
 *
 * Deliberately does **not** import TripsModule. This service reads and locks
 * trip rows through Prisma directly, exactly as TripsService reads and locks
 * driver and vehicle rows, so the two modules stay independent and no
 * circular dependency can form — TripsService's own expense query for the
 * verification gate likewise needs nothing from here.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [
    ExpensesController,
    TripExpensesController,
    DriverTripExpensesController,
    DriverExpensesController,
  ],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
