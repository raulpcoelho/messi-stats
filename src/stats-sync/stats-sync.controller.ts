import { Controller, Header, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { StatsSyncGuard } from './stats-sync.guard';
import { StatsSyncService } from './stats-sync.service';

@ApiExcludeController()
@Controller('admin/stats')
@UseGuards(StatsSyncGuard)
export class StatsSyncController {
  constructor(private readonly service: StatsSyncService) {}

  @Post('sync')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  sync() {
    return this.service.sync();
  }
}
