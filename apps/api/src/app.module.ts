import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DriversModule } from './drivers/drivers.module.js';
import { ExpensesModule } from './expenses/expenses.module.js';
import { HealthController } from './health/health.controller.js';
import { ReceiptsModule } from './receipts/receipts.module.js';
import { TripsModule } from './trips/trips.module.js';
import { VehiclesModule } from './vehicles/vehicles.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    DriversModule,
    VehiclesModule,
    TripsModule,
    ExpensesModule,
    ReceiptsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
