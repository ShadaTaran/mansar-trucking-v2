import type { Page, Trip } from '@mansar/types';
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
  type AssignTripBody,
  assignTripSchema,
  type CreateTripBody,
  createTripSchema,
  type ListTripsQuery,
  listTripsSchema,
  tripIdSchema,
  type UpdateTripBody,
  updateTripSchema,
} from './trips.schemas.js';
import { TripsService } from './trips.service.js';

/**
 * Admin management of trips (Stage 5B). ADMIN only for the whole controller.
 *
 * There is no delete route — trips are cancelled, never removed — and no
 * start or complete route: running a trip belongs to the driver, in Stage 5C.
 */
@Roles('ADMIN')
@Controller('trips')
export class TripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(
    @Query({ schema: listTripsSchema }) query: ListTripsQuery,
  ): Promise<Page<Trip>> {
    return this.trips.list(query);
  }

  @Get(':id')
  getOne(@Param('id', { schema: tripIdSchema }) tripId: string): Promise<Trip> {
    return this.trips.getOne(tripId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body({ schema: createTripSchema }) body: CreateTripBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.create({ actor, body, requestId });
  }

  @Patch(':id')
  update(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @Body({ schema: updateTripSchema }) body: UpdateTripBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.update({ actor, tripId, body, requestId });
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  assign(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @Body({ schema: assignTripSchema }) body: AssignTripBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.assign({ actor, tripId, body, requestId });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.cancel({ actor, tripId, requestId });
  }

  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  verify(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.verify({ actor, tripId, requestId });
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.close({ actor, tripId, requestId });
  }
}
