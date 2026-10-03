import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';

@Controller()
export class HealthController {
  @Get('health')
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', example: 'ok' } },
    },
  })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
