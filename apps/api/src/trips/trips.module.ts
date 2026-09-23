import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DriverTripsController } from './driver-trips.controller.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

/**
 * Trips. One service behind two controllers: `/trips` for ADMIN (Stage 5B)
 * and `/driver/trips` for the driver executing them (Stage 5C). No
 * authentication dependency beyond the global guards — the driver-side
 * operations resolve their operational driver through `drivers.user_id` and
 * never touch sessions or accounts.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [TripsController, DriverTripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
