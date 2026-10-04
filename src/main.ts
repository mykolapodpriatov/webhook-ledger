import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { loadTenants } from './config';

async function bootstrap(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Start Postgres with `docker compose up -d` and copy DATABASE_URL from .env.example.',
    );
  }
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      tenants: loadTenants(process.env.LEDGER_TENANTS),
      databaseUrl,
    }),
    new FastifyAdapter({ bodyLimit: 256 * 1024 }),
    { rawBody: true },
  );
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
