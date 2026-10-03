import { Module, type DynamicModule } from '@nestjs/common';
import { parseTenants, type TenantConfig } from '../config';
import { LedgerController } from './ledger.controller';
import { LEDGER_OPTIONS, LedgerService, type Clock } from './ledger.service';
import { MemoryLedgerStore } from './memory-ledger.store';

export type LedgerModuleOptions = {
  tenants: TenantConfig[];
  clock?: Clock;
  toleranceSeconds?: number;
};

const systemClock: Clock = { now: () => new Date() };

@Module({})
export class LedgerModule {
  static register(options: LedgerModuleOptions): DynamicModule {
    return {
      module: LedgerModule,
      controllers: [LedgerController],
      providers: [
        MemoryLedgerStore,
        LedgerService,
        {
          provide: LEDGER_OPTIONS,
          useValue: {
            tenants: parseTenants(options.tenants),
            clock: options.clock ?? systemClock,
            toleranceSeconds: options.toleranceSeconds ?? 300,
          },
        },
      ],
    };
  }
}
