import type { Page, Trip, TripLocationSample } from '@mansar/types';
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
  type ListLocationSamplesQuery,
  listLocationSamplesSchema,
  type ListTripsQuery,
  listTripsSchema,
  tripIdParamSchema,
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
 *
 * The two location routes (Stage 8D.1) are reads of what the driver app
 * already uploaded. They are the only admin view of location anywhere in the
 * API: there is no fleet, driver or vehicle timeline, and no live channel.
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

  /**
   * The latest stored position for this trip (Stage 8D.1).
   *
   * A trip with nothing recorded answers `trip_location_unknown`, which is
   * not the same as `trip_not_found` and is not a coordinate.
   */
  @Get(':tripId/location')
  latestLocation(
    @Param('tripId', { schema: tripIdParamSchema }) tripId: string,
  ): Promise<TripLocationSample> {
    return this.trips.latestLocation(tripId);
  }

  /** This trip's stored history, in capture order (Stage 8D.1). */
  @Get(':tripId/location-samples')
  listLocationSamples(
    @Param('tripId', { schema: tripIdParamSchema }) tripId: string,
    @Query({ schema: listLocationSamplesSchema })
    query: ListLocationSamplesQuery,
  ): Promise<Page<TripLocationSample>> {
    return this.trips.listLocationSamples({ tripId, query });
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
