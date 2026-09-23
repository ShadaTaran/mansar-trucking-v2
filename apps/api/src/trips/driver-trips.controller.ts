import type { Page, Trip } from '@mansar/types';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser, RequestId, Roles } from '../auth/decorators.js';
import type { AuthenticatedPrincipal } from '../auth/principal.js';
import {
  type ListDriverTripsQuery,
  listDriverTripsSchema,
  tripIdSchema,
} from './trips.schemas.js';
import { TripsService } from './trips.service.js';

/**
 * A driver's own trips (Stage 5C). DRIVER only for the whole controller: an
 * ADMIN gets 403 here and uses `/trips` instead.
 *
 * Read and execute only. There is no create, update, assign, cancel, verify,
 * close or delete route — every one of those is an administrative action and
 * lives on the ADMIN controller. The driver is always the operational driver
 * linked to the authenticated login; no route accepts a driver id.
 */
@Roles('DRIVER')
@Controller('driver/trips')
export class DriverTripsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  list(
    @Query({ schema: listDriverTripsSchema }) query: ListDriverTripsQuery,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<Page<Trip>> {
    return this.trips.listForDriver({ actor, query });
  }

  @Get(':id')
  getOne(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<Trip> {
    return this.trips.getOneForDriver({ actor, tripId });
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  start(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.start({ actor, tripId, requestId });
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @CurrentUser() actor: AuthenticatedPrincipal,
    @RequestId() requestId: string,
  ): Promise<Trip> {
    return this.trips.complete({ actor, tripId, requestId });
  }
}
