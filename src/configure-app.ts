import type { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { ZodValidationPipe } from 'nestjs-zod';
import { createOpenApiDocument } from './openapi';

export function configureApp(app: INestApplication): void {
  app.useGlobalPipes(new ZodValidationPipe());
  SwaggerModule.setup('docs', app, createOpenApiDocument(app));
}
