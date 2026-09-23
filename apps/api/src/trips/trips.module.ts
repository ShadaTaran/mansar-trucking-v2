import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { TripsController } from './trips.controller.js';
import { TripsService } from './trips.service.js';

/**
 * Trips (Stage 5B, ADMIN only). No authentication dependency beyond the
 * global guards: nothing here touches sessions or accounts.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
