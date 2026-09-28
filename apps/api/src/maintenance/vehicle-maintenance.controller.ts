import type { MaintenanceRecord } from '@mansar/types';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type CreateMaintenanceBody,
  createMaintenanceSchema,
  vehicleIdParamSchema,
} from './maintenance.schemas.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * Filing maintenance against one vehicle (Stage 7B.3). ADMIN only.
 *
 * Creation hangs off the vehicle because a maintenance record has no
 * independent existence — the same shape as `POST /trips/:tripId/expenses`.
 * The result is always an `OPEN` record with no completion instant; neither is
 * accepted from the request.
 *
 * Deliberately **write-only**. There is no `GET` here: vehicle-scoped reads go
 * through `GET /maintenance?vehicleId=…`, matching the ADMIN expense listing
 * rather than offering two paths to the same rows.
 *
 * The vehicle's status is not a precondition. A record may be filed against an
 * `ACTIVE`, `IN_MAINTENANCE` or `RETIRED` vehicle, and filing one never changes
 * that status (ADR 0010) — availability stays an explicit administrative
 * decision made through `POST /vehicles/:id/status`.
 */
@Roles('ADMIN')
@Controller('vehicles/:vehicleId/maintenance')
export class VehicleMaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('vehicleId', { schema: vehicleIdParamSchema }) vehicleId: string,
    @Body({ schema: createMaintenanceSchema }) body: CreateMaintenanceBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.createForVehicle({
      actor,
      vehicleId,
      body,
      requestId,
    });
  }
}
