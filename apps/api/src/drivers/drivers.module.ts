import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DriversController } from './drivers.controller.js';
import { DriversService } from './drivers.service.js';

/**
 * Operational drivers (Stage 4B). Depends on AuthModule only for
 * RefreshSessionService: deactivating a driver revokes the linked login's
 * sessions inside the same transaction.
 */
@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
