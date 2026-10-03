import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health.controller';
import { LedgerModule, type LedgerModuleOptions } from './ledger/ledger.module';

@Module({})
export class AppModule {
  static register(options: LedgerModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [LedgerModule.register(options)],
      controllers: [HealthController],
    };
  }
}
