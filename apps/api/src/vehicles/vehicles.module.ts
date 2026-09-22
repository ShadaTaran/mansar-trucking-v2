import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { VehiclesController } from './vehicles.controller.js';
import { VehiclesService } from './vehicles.service.js';

/**
 * Fleet vehicles (Stage 4C). No authentication dependency beyond the global
 * guards: nothing here touches sessions or accounts.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [VehiclesController],
  providers: [VehiclesService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
