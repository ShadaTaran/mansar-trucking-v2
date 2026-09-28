import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { VehicleMaintenanceController } from './vehicle-maintenance.controller.js';

/**
 * Vehicle maintenance (Stage 7B.3). One service behind two ADMIN controllers,
 * one per path prefix: `/maintenance` for reads and lifecycle, and
 * `/vehicles/:vehicleId/maintenance` for creation.
 *
 * Deliberately imports neither VehiclesModule nor TripsModule. The vehicle
 * existence check reads the row through Prisma directly, exactly as
 * ExpensesService reads trip rows, so the modules stay independent and no
 * circular dependency can form. Nothing here calls `VehiclesService` — in
 * particular not `setStatus`, because maintenance never writes vehicle
 * availability (ADR 0010) — and no trip is read at all.
 */
@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [MaintenanceController, VehicleMaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
