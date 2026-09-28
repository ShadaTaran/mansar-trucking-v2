import type { MaintenanceRecord, Page } from '@mansar/types';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type CancelMaintenanceBody,
  cancelMaintenanceSchema,
  type CompleteMaintenanceBody,
  completeMaintenanceSchema,
  type ListMaintenanceQuery,
  listMaintenanceSchema,
  maintenanceIdSchema,
  type UpdateMaintenanceBody,
  updateMaintenanceSchema,
} from './maintenance.schemas.js';
import { MaintenanceService } from './maintenance.service.js';

/**
 * The maintenance work log (Stage 7B.3). ADMIN only for the whole controller;
 * a DRIVER receives `403` and has no maintenance surface at all.
 *
 * There is no delete route. Stage 7 removes nothing — a mis-filed record is
 * cancelled, and an incorrect confirmed one is superseded by a new record, so
 * the incorrect row survives as history (ADR 0010).
 *
 * There is no reopen route either: `COMPLETED` and `CANCELLED` are terminal.
 *
 * Creation lives on `/vehicles/:vehicleId/maintenance`, because a record only
 * exists against a vehicle. Vehicle-scoped reads use `GET /maintenance` with
 * the `vehicleId` filter, matching the ADMIN expense listing rather than
 * adding a second nested read path.
 */
@Roles('ADMIN')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get()
  list(
    @Query({ schema: listMaintenanceSchema }) query: ListMaintenanceQuery,
  ): Promise<Page<MaintenanceRecord>> {
    return this.maintenance.list(query);
  }

  @Get(':id')
  getOne(
    @Param('id', { schema: maintenanceIdSchema }) maintenanceId: string,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.getOne(maintenanceId);
  }

  /** Corrections while the record is still OPEN; terminal rows are immutable. */
  @Patch(':id')
  update(
    @Param('id', { schema: maintenanceIdSchema }) maintenanceId: string,
    @Body({ schema: updateMaintenanceSchema }) body: UpdateMaintenanceBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.update({ actor, maintenanceId, body, requestId });
  }

  /**
   * `OPEN → COMPLETED`. The body carries the completion instant and the final
   * cost, both required, because completion is where those two facts are
   * settled and the record becomes immutable.
   */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id', { schema: maintenanceIdSchema }) maintenanceId: string,
    @Body({ schema: completeMaintenanceSchema }) body: CompleteMaintenanceBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.complete({ actor, maintenanceId, body, requestId });
  }

  /**
   * `OPEN → CANCELLED`, for a record that should not have been filed.
   *
   * No body: the server already knows what it is cancelling. The empty-body
   * schema is bound rather than the parameter simply being omitted, so a
   * client cannot believe it passed an override the server quietly ignored.
   * The parsed value is unused by design; it exists so the pipe runs.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    // Deliberately first. Nest resolves parameters by decorator rather than
    // position, and the lint rule only reports an unused argument that follows
    // the last used one — so an intentionally unused body sits ahead of the
    // parameters this handler actually reads.
    @Body({ schema: cancelMaintenanceSchema }) _body: CancelMaintenanceBody,
    @Param('id', { schema: maintenanceIdSchema }) maintenanceId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<MaintenanceRecord> {
    return this.maintenance.cancel({ actor, maintenanceId, requestId });
  }
}
