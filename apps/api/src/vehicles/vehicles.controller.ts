import type { Page, Vehicle } from '@mansar/types';
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
  type CreateVehicleBody,
  createVehicleSchema,
  type ListVehiclesQuery,
  listVehiclesSchema,
  type UpdateVehicleBody,
  updateVehicleSchema,
  vehicleIdSchema,
  type VehicleStatusBody,
  vehicleStatusSchema,
} from './vehicles.schemas.js';
import { VehiclesService } from './vehicles.service.js';

/**
 * Admin management of fleet vehicles. ADMIN only for the whole controller,
 * and there is no delete route: vehicles are retired, never removed.
 */
@Roles('ADMIN')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Get()
  list(
    @Query({ schema: listVehiclesSchema }) query: ListVehiclesQuery,
  ): Promise<Page<Vehicle>> {
    return this.vehicles.list(query);
  }

  @Get(':id')
  getOne(
    @Param('id', { schema: vehicleIdSchema }) vehicleId: string,
  ): Promise<Vehicle> {
    return this.vehicles.getOne(vehicleId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body({ schema: createVehicleSchema }) body: CreateVehicleBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Vehicle> {
    return this.vehicles.create({ actor, body, requestId });
  }

  @Patch(':id')
  update(
    @Param('id', { schema: vehicleIdSchema }) vehicleId: string,
    @Body({ schema: updateVehicleSchema }) body: UpdateVehicleBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Vehicle> {
    return this.vehicles.update({ actor, vehicleId, body, requestId });
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id', { schema: vehicleIdSchema }) vehicleId: string,
    @Body({ schema: vehicleStatusSchema }) body: VehicleStatusBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Vehicle> {
    return this.vehicles.setStatus({
      actor,
      vehicleId,
      status: body.status,
      requestId,
    });
  }
}
