import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StatsSyncController } from './stats-sync.controller';
import { StatsSyncGuard } from './stats-sync.guard';
import { StatsSyncService } from './stats-sync.service';

@Module({
  imports: [DatabaseModule],
  controllers: [StatsSyncController],
  providers: [StatsSyncService, StatsSyncGuard],
})
export class StatsSyncModule {}
