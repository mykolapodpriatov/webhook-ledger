import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Nest does not run pipes on `@Headers()`. A custom param decorator is pipeable,
 * so the global Zod pipe can validate the header object.
 */
export const RequestHeaders = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): FastifyRequest['headers'] => {
    return ctx.switchToHttp().getRequest<FastifyRequest>().headers;
  },
);
