import type { Driver, Page } from '@mansar/types';
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
  type CreateDriverBody,
  createDriverSchema,
  type DriverStatusBody,
  driverIdSchema,
  driverStatusSchema,
  type LinkDriverUserBody,
  linkDriverUserSchema,
  type ListDriversQuery,
  listDriversSchema,
  type UpdateDriverBody,
  updateDriverSchema,
} from './drivers.schemas.js';
import { type DriverStatusResult, DriversService } from './drivers.service.js';

/**
 * Admin management of operational drivers. ADMIN only for the whole
 * controller (`@Roles` is never implied by authentication), and there is no
 * delete route: drivers are deactivated, never removed.
 */
@Roles('ADMIN')
@Controller('drivers')
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  list(
    @Query({ schema: listDriversSchema }) query: ListDriversQuery,
  ): Promise<Page<Driver>> {
    return this.drivers.list(query);
  }

  @Get(':id')
  getOne(
    @Param('id', { schema: driverIdSchema }) driverId: string,
  ): Promise<Driver> {
    return this.drivers.getOne(driverId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body({ schema: createDriverSchema }) body: CreateDriverBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Driver> {
    return this.drivers.create({ actor, body, requestId });
  }

  @Patch(':id')
  update(
    @Param('id', { schema: driverIdSchema }) driverId: string,
    @Body({ schema: updateDriverSchema }) body: UpdateDriverBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Driver> {
    return this.drivers.update({ actor, driverId, body, requestId });
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  setStatus(
    @Param('id', { schema: driverIdSchema }) driverId: string,
    @Body({ schema: driverStatusSchema }) body: DriverStatusBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<DriverStatusResult> {
    return this.drivers.setStatus({
      actor,
      driverId,
      status: body.status,
      requestId,
    });
  }

  @Post(':id/link-user')
  @HttpCode(HttpStatus.OK)
  linkUser(
    @Param('id', { schema: driverIdSchema }) driverId: string,
    @Body({ schema: linkDriverUserSchema }) body: LinkDriverUserBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Driver> {
    return this.drivers.linkUser({
      actor,
      driverId,
      email: body.email,
      requestId,
    });
  }

  @Post(':id/unlink-user')
  @HttpCode(HttpStatus.OK)
  unlinkUser(
    @Param('id', { schema: driverIdSchema }) driverId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Driver> {
    return this.drivers.unlinkUser({ actor, driverId, requestId });
  }
}
