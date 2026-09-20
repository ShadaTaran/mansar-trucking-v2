import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
