import { Module, type DynamicModule } from '@nestjs/common';
import { parseTenants, type TenantConfig } from '../config';
import { LEDGER_STORE } from './ledger-store';
import { LedgerController } from './ledger.controller';
import { LEDGER_OPTIONS, LedgerService, type Clock } from './ledger.service';
import { MemoryLedgerStore } from './memory-ledger.store';
import { PostgresLedgerStore } from './postgres-ledger.store';

export type LedgerModuleOptions = {
  tenants: TenantConfig[];
  clock?: Clock;
  toleranceSeconds?: number;
  databaseUrl?: string;
};

const systemClock: Clock = { now: () => new Date() };

@Module({})
export class LedgerModule {
  static register(options: LedgerModuleOptions): DynamicModule {
    const store = options.databaseUrl ? PostgresLedgerStore : MemoryLedgerStore;
    return {
      module: LedgerModule,
      controllers: [LedgerController],
      providers: [
        store,
        { provide: LEDGER_STORE, useExisting: store },
        LedgerService,
        {
          provide: LEDGER_OPTIONS,
          useValue: {
            tenants: parseTenants(options.tenants),
            clock: options.clock ?? systemClock,
            toleranceSeconds: options.toleranceSeconds ?? 300,
            databaseUrl: options.databaseUrl,
          },
        },
      ],
    };
  }
}
