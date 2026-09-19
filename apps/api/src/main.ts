import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { loadLocalEnv } from './config/local-env.js';

const DEFAULT_PORT = 3001;

async function bootstrap(): Promise<void> {
  loadLocalEnv();

  const app = await NestFactory.create(AppModule);
  // Let SIGTERM/SIGINT run module destroy hooks (Prisma pool disposal).
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
}

await bootstrap();
