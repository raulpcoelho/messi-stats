import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';
import { TypeOrmService } from '../database/typeorm.service';
import { Match } from '../matches/entities/match.entity';
import { Team } from '../teams/entities/team.entity';
import { Season } from '../seasons/entities/season.entity';
import { Competition } from '../competitions/entities/competition.entity';
import { parseStatsSource } from './stats-source';

function dateKey(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

@Injectable()
export class StatsSyncService {
  private syncing = false;

  constructor(private readonly database: TypeOrmService) {}

  async sync() {
    if (this.syncing) throw new ConflictException('A stats update is already in progress.');
    this.syncing = true;
    try {
      const matches = await this.fetchMatches();
      const runner = this.database.createQueryRunner();
      try {
        await runner.connect();
        await runner.startTransaction();
        // A transaction-scoped database lock also protects separate serverless instances.
        const [lock] = await runner.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [1297306707]);
        if (!lock.locked) throw new ConflictException('A stats update is already in progress.');

        const existing = await runner.manager.find(Match, {
          relations: { team: true, opponent: true, competition: true, season: true },
        });
        const byDate = new Map<string, Match>();
        for (const match of existing) {
          const key = dateKey(match.matchDate);
          if (byDate.has(key)) throw new ConflictException('The database contains duplicate match dates.');
          byDate.set(key, match);
        }

        const teams = await this.ensureNames(
          runner.manager,
          Team,
          matches.flatMap(m => [m.team, m.opponent]),
        );
        const seasons = await this.ensureNames(
          runner.manager,
          Season,
          matches.map(m => m.season),
        );
        const competitions = await this.ensureNames(
          runner.manager,
          Competition,
          matches.map(m => m.competition),
        );
        const result = { fetched: matches.length, inserted: 0, updated: 0, unchanged: 0 };
        const changes: Match[] = [];

        for (const dto of matches) {
          const previous = byDate.get(dateKey(dto.matchDate));
          const values = {
            ...dto,
            // Persist a calendar date: TypeORM formats Date objects in the host timezone.
            matchDate: dateKey(dto.matchDate) as unknown as Date,
            team: teams.get(dto.team),
            opponent: teams.get(dto.opponent),
            season: seasons.get(dto.season),
            competition: competitions.get(dto.competition),
          };
          const changed =
            !previous ||
            Object.entries(values).some(([key, value]) => {
              if (key === 'matchDate') return false;
              if (['team', 'opponent', 'season', 'competition'].includes(key)) {
                return previous[key]?.id !== (value as { id: number }).id;
              }
              return previous[key] !== value;
            });
          if (!changed) {
            result.unchanged++;
            continue;
          }
          changes.push(runner.manager.create(Match, { ...previous, ...values, updatedAt: new Date() }));
          if (previous) result.updated++;
          else result.inserted++;
        }
        if (changes.length) await runner.manager.save(Match, changes, { chunk: 100 });
        await runner.commitTransaction();
        return result;
      } catch (error) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        if (error instanceof HttpException) throw error;
        throw new InternalServerErrorException('Unable to save stats. The update was rolled back.');
      } finally {
        await runner.release();
      }
    } finally {
      this.syncing = false;
    }
  }

  private async fetchMatches() {
    const source = process.env.API_MVSR_APP;
    try {
      if (!source || !['http:', 'https:'].includes(new URL(source).protocol)) throw new Error();
    } catch {
      throw new ServiceUnavailableException('The stats source is not configured on this server.');
    }
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error();
      return parseStatsSource(await response.json());
    } catch {
      // Never expose the private source URL, payload, or fetch error to the browser.
      throw new BadGatewayException('Unable to fetch valid stats. No data was changed.');
    }
  }

  private async ensureNames<T extends ObjectLiteral & { name: string }>(
    manager: EntityManager,
    entity: EntityTarget<T>,
    names: string[],
  ): Promise<Map<string, T>> {
    const existing = await manager.find(entity);
    const byName = new Map(existing.map(item => [item.name, item]));
    const missing = [...new Set(names)].filter(name => !byName.has(name));
    if (missing.length) {
      const saved = await manager.save(
        entity,
        missing.map(name => manager.create(entity, { name } as any)),
      );
      saved.forEach(item => byName.set(item.name, item));
    }
    return byName;
  }
}
