import type { Page, Trip } from '@mansar/types';
import {
  Body,
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
  type IngestLocationSamplesBody,
  ingestLocationSamplesSchema,
  type ListDriverTripsQuery,
  listDriverTripsSchema,
  tripIdSchema,
} from './trips.schemas.js';
import { type LocationIngestionResult, TripsService } from './trips.service.js';

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

  /**
   * Ingests a batch of queued location samples for this trip (Stage 8B.2).
   *
   * 200 for every structurally valid batch, even one whose samples are all
   * refused: the per-sample outcomes are the answer, and a device needs them
   * to know which rows it may delete from its queue. A malformed body is a 400
   * and writes nothing.
   *
   * No `@RequestId()`: nothing here is audited, so there is no correlation id
   * to carry (Stage 8 writes no audit row per coordinate).
   */
  @Post(':id/location-samples')
  @HttpCode(HttpStatus.OK)
  ingestLocationSamples(
    @Param('id', { schema: tripIdSchema }) tripId: string,
    @Body({ schema: ingestLocationSamplesSchema })
    body: IngestLocationSamplesBody,
    @CurrentUser() actor: AuthenticatedPrincipal,
  ): Promise<LocationIngestionResult> {
    return this.trips.ingestLocationSamples({ actor, tripId, body });
  }
}
