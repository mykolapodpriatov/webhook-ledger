import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const tenantId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const TenantParamSchema = z.object({
  tenantId,
});
export class TenantParamDto extends createZodDto(TenantParamSchema) {}

export const IngestHeadersSchema = z.object({
  'idempotency-key': z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  'x-webhook-timestamp': z.string().regex(/^\d{1,15}$/),
  'x-webhook-signature': z.string().regex(/^[0-9a-fA-F]{64}$/),
});
export class IngestHeadersDto extends createZodDto(IngestHeadersSchema) {}

export const IngestBodySchema = z.object({}).catchall(z.unknown());
export class IngestBodyDto extends createZodDto(IngestBodySchema) {}

export const ReadHeadersSchema = z.object({
  authorization: z.string().regex(/^Bearer \S+$/),
});
export class ReadHeadersDto extends createZodDto(ReadHeadersSchema) {}

export const FeedQuerySchema = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export class FeedQueryDto extends createZodDto(FeedQuerySchema) {}

export const AcceptResponseSchema = z.object({
  status: z.enum(['accepted', 'replayed']),
  id: z.string(),
  tenantId: z.string(),
  sequence: z.number().int(),
  receivedAt: z.string(),
});
export class AcceptResponseDto extends createZodDto(AcceptResponseSchema) {}

export const FeedEventSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  sequence: z.number().int(),
  idempotencyKey: z.string(),
  receivedAt: z.string(),
  body: z.unknown(),
});

export const FeedResponseSchema = z.object({
  events: z.array(FeedEventSchema),
  nextCursor: z.string().nullable(),
});
export class FeedResponseDto extends createZodDto(FeedResponseSchema) {}
