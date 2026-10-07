import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { MatchesModule } from './matches/matches.module';
import { SeasonsModule } from './seasons/seasons.module';
import { CompetitionsModule } from './competitions/competitions.module';
import { TeamsModule } from './teams/teams.module';
import { TotalsModule } from './totals/totals.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { StatsSyncModule } from './stats-sync/stats-sync.module';

@Module({
  imports: [
    DatabaseModule,
    MatchesModule,
    SeasonsModule,
    CompetitionsModule,
    TeamsModule,
    TotalsModule,
    StatsSyncModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
