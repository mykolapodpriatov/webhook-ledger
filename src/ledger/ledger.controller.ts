import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Query,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiResponse } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LedgerService, type PublicEvent } from './ledger.service';
import { RequestHeaders } from './request-headers';
import {
  AcceptResponseDto,
  FeedQueryDto,
  FeedResponseDto,
  IngestBodyDto,
  IngestHeadersDto,
  ReadHeadersDto,
  TenantParamDto,
} from './schemas';

@Controller('v1/tenants/:tenantId')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('events')
  @ApiHeader({ name: 'idempotency-key', required: true })
  @ApiHeader({ name: 'x-webhook-timestamp', required: true, description: 'Unix seconds' })
  @ApiHeader({
    name: 'x-webhook-signature',
    required: true,
    description: 'Hex HMAC-SHA256 of `${timestamp}.${rawBody}`',
  })
  @ApiBody({ type: IngestBodyDto })
  @ApiResponse({ status: 202, type: AcceptResponseDto })
  @ApiResponse({ status: 200, type: AcceptResponseDto })
  @ApiResponse({ status: 401, description: 'invalid_signature or stale_timestamp' })
  @ApiResponse({ status: 409, description: 'idempotency_conflict' })
  async accept(
    @Param() params: TenantParamDto,
    @RequestHeaders() headers: IngestHeadersDto,
    @Body() body: IngestBodyDto,
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AcceptResponseDto> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw httpError(
        500,
        'raw_body_unavailable',
        'Raw body is not available. Start the server with rawBody enabled.',
      );
    }

    const result = await this.ledger.accept({
      tenantId: params.tenantId,
      rawBody,
      body,
      timestamp: headers['x-webhook-timestamp'],
      signature: headers['x-webhook-signature'],
      idempotencyKey: headers['idempotency-key'],
    });

    switch (result.kind) {
      case 'accepted':
        reply.status(202);
        return toAcceptBody('accepted', result.event);
      case 'replayed':
        reply.status(200);
        return toAcceptBody('replayed', result.event);
      case 'invalid_signature':
        throw httpError(401, 'invalid_signature', 'Signature verification failed.');
      case 'stale_timestamp':
        throw httpError(
          401,
          'stale_timestamp',
          'Timestamp is outside the allowed window.',
        );
      case 'idempotency_conflict':
        throw new HttpException(
          {
            statusCode: 409,
            error: 'idempotency_conflict',
            message: 'This idempotency key was already used with a different body.',
            eventId: result.eventId,
          },
          409,
        );
    }
  }

  @Get('events')
  @ApiBearerAuth()
  @ApiResponse({ status: 200, type: FeedResponseDto })
  @ApiResponse({ status: 401, description: 'unauthorized' })
  async feed(
    @Param() params: TenantParamDto,
    @RequestHeaders() headers: ReadHeadersDto,
    @Query() query: FeedQueryDto,
  ): Promise<FeedResponseDto> {
    const token = headers.authorization.slice('Bearer '.length);
    const after = query.after === undefined ? undefined : Number(query.after);
    const result = await this.ledger.read({
      tenantId: params.tenantId,
      token,
      after,
      limit: query.limit ?? 50,
    });

    switch (result.kind) {
      case 'ok':
        return { events: result.events, nextCursor: result.nextCursor };
      case 'unauthorized':
        throw httpError(401, 'unauthorized', 'Read token was rejected.');
      case 'invalid_cursor':
        throw httpError(400, 'invalid_cursor', 'The after cursor is not valid.');
    }
  }
}

function toAcceptBody(
  status: 'accepted' | 'replayed',
  event: PublicEvent,
): AcceptResponseDto {
  return {
    status,
    id: event.id,
    tenantId: event.tenantId,
    sequence: event.sequence,
    receivedAt: event.receivedAt,
  };
}

function httpError(status: number, error: string, message: string): HttpException {
  return new HttpException({ statusCode: status, error, message }, status);
}
