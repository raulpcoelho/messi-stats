import {
  BadGatewayException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityTarget, ObjectLiteral, QueryRunner } from 'typeorm';
import { TypeOrmService } from '../database/typeorm.service';
import { Match } from '../matches/entities/match.entity';
import { Team } from '../teams/entities/team.entity';
import { Season } from '../seasons/entities/season.entity';
import { Competition } from '../competitions/entities/competition.entity';
import { parseStatsSource } from './stats-source';

function dateKey(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function databaseErrorCode(error: any): string {
  const code = error?.driverError?.code ?? error?.code;
  if (
    typeof code === 'string' &&
    (/^[0-9A-Z]{5}$/.test(code) || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(code))
  )
    return code;
  return 'unknown';
}

function databaseConstraint(error: any): string | undefined {
  const name = error?.driverError?.constraint ?? error?.constraint;
  return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name) ? name : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

@Injectable()
export class StatsSyncService {
  private syncing = false;
  private readonly logger = new Logger(StatsSyncService.name);

  constructor(private readonly database: TypeOrmService) {}

  async sync() {
    if (this.syncing) throw new ConflictException('A stats update is already in progress.');
    this.syncing = true;
    try {
      const matches = await this.fetchMatches();
      const runner = this.database.createQueryRunner();
      let stage = 'connect';
      let connection: { end(): Promise<void> };
      let rollbackFailed = false;
      try {
        connection = await runner.connect();
        stage = 'start_transaction';
        await runner.startTransaction();
        stage = 'configure_transaction';
        // Server-side limits still apply if the hosting platform freezes or terminates the request.
        await runner.query("SET LOCAL statement_timeout = '15s'");
        await runner.query("SET LOCAL lock_timeout = '3s'");
        await runner.query("SET LOCAL idle_in_transaction_session_timeout = '20s'");
        stage = 'lock';
        // A transaction-scoped database lock also protects separate serverless instances.
        const [lock] = await runner.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [1297306707]);
        if (!lock.locked) throw new ConflictException('A stats update is already in progress.');

        stage = 'read_matches';
        const existing = await runner.manager.find(Match, {
          relations: { team: true, opponent: true, competition: true, season: true },
        });
        const byDate = new Map<string, Match>();
        for (const match of existing) {
          const key = dateKey(match.matchDate);
          if (byDate.has(key)) throw new ConflictException('The database contains duplicate match dates.');
          byDate.set(key, match);
        }
        const sourceDates = new Set(matches.map(match => dateKey(match.matchDate)));
        const removedDates = existing.filter(match => !sourceDates.has(dateKey(match.matchDate)));
        const addedDates = matches.filter(match => !byDate.has(dateKey(match.matchDate)));
        // Recognize one isolated date shift in an otherwise complete snapshot.
        const shiftedMatch =
          existing.length > 1 && removedDates.length === 1 && addedDates.length === 1 ? removedDates[0] : undefined;

        stage = 'save_teams';
        const teams = await this.ensureNames(
          runner,
          Team,
          matches.flatMap(m => [m.team, m.opponent]),
        );
        stage = 'save_seasons';
        const seasons = await this.ensureNames(
          runner,
          Season,
          matches.map(m => m.season),
        );
        stage = 'save_competitions';
        const competitions = await this.ensureNames(
          runner,
          Competition,
          matches.map(m => m.competition),
        );
        const result = { fetched: matches.length, inserted: 0, updated: 0, unchanged: 0 };
        const changes: Match[] = [];

        for (const dto of matches) {
          let previous = byDate.get(dateKey(dto.matchDate));
          if (
            !previous &&
            shiftedMatch &&
            Math.abs(new Date(dateKey(shiftedMatch.matchDate)).getTime() - dto.matchDate.getTime()) === 86400000 &&
            Object.entries(dto).every(([key, value]) => {
              if (key === 'matchDate') return true;
              if (['team', 'opponent', 'season', 'competition'].includes(key)) return shiftedMatch[key]?.name === value;
              return shiftedMatch[key] === value;
            })
          )
            previous = shiftedMatch;
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
              if (key === 'matchDate') return dateKey(previous.matchDate) !== dateKey(value as Date);
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
        if (result.inserted) {
          stage = 'align_matches_sequence';
          await this.alignSequence(runner, Match);
        }
        stage = 'save_matches';
        if (changes.length) await runner.manager.save(Match, changes, { chunk: 100 });
        stage = 'commit';
        await runner.commitTransaction();
        return result;
      } catch (error) {
        const code = databaseErrorCode(error);
        const constraint = databaseConstraint(error);
        const diagnostic = { stage, databaseCode: code, ...(constraint && { databaseConstraint: constraint }) };
        this.logger.error({ event: 'stats_sync_failed', ...diagnostic });
        if (runner.isTransactionActive && !runner.isReleased) {
          try {
            await runner.rollbackTransaction();
          } catch (rollbackError) {
            rollbackFailed = true;
            this.logger.error({
              event: 'stats_sync_cleanup_failed',
              stage: 'rollback',
              databaseCode: databaseErrorCode(rollbackError),
            });
            // A client with an unclosed transaction must never return to the shared pool.
            if (connection && !runner.isReleased) {
              try {
                await connection.end();
              } catch {
                this.logger.error({ event: 'stats_sync_cleanup_failed', stage: 'disconnect' });
              }
            }
          }
        }
        if (rollbackFailed) {
          throw new ServiceUnavailableException({
            message: 'Stats update failed and the database connection was closed. Check server logs before retrying.',
            ...diagnostic,
          });
        }
        if (error instanceof HttpException) throw error;
        const message =
          stage === 'connect'
            ? 'Unable to connect to the database. No data was changed.'
            : 'Unable to save stats. The update was rolled back.';
        throw new InternalServerErrorException({ message, ...diagnostic });
      } finally {
        try {
          await runner.release();
        } catch (releaseError) {
          this.logger.error({
            event: 'stats_sync_cleanup_failed',
            stage: 'release',
            databaseCode: databaseErrorCode(releaseError),
          });
          if (connection) {
            try {
              await connection.end();
            } catch {
              this.logger.error({ event: 'stats_sync_cleanup_failed', stage: 'disconnect' });
            }
          }
        }
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
    runner: QueryRunner,
    entity: EntityTarget<T>,
    names: string[],
  ): Promise<Map<string, T>> {
    const manager = runner.manager;
    const existing = await manager.find(entity);
    const byName = new Map(existing.map(item => [item.name, item]));
    const missing = [...new Set(names)].filter(name => !byName.has(name));
    if (missing.length) {
      await this.alignSequence(runner, entity);
      const saved = await manager.save(
        entity,
        missing.map(name => manager.create(entity, { name } as any)),
      );
      saved.forEach(item => byName.set(item.name, item));
    }
    return byName;
  }

  private async alignSequence(runner: QueryRunner, entity: EntityTarget<ObjectLiteral>): Promise<void> {
    const metadata = this.database.getMetadata(entity);
    const table = [metadata.schema, metadata.tableName].filter(Boolean).map(quoteIdentifier).join('.');
    // Prevent other writers changing MAX(id) during repair; ordinary SELECTs can still run.
    await runner.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
    const [owned] = await runner.query('SELECT pg_get_serial_sequence($1, $2) AS sequence', [table, 'id']);
    if (!owned?.sequence) throw new ServiceUnavailableException('Automatic database IDs are not configured.');

    // nextval needs only USAGE permission, unlike selecting the sequence directly.
    const [candidate] = await runner.query('SELECT nextval($1::regclass)::text AS next_id', [owned.sequence]);
    const [state] = await runner.query(
      `SELECT (SELECT COALESCE(MAX("id"), 0)::text FROM ${table}) AS max_id,
        s.last_value::text AS last_value
       FROM pg_sequences s
       JOIN pg_namespace n ON n.nspname = s.schemaname
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = s.sequencename
       WHERE c.oid = $1::regclass`,
      [owned.sequence],
    );
    if (!state) throw new ServiceUnavailableException('Automatic database IDs are not configured.');
    if (BigInt(candidate.next_id) <= BigInt(state.max_id)) {
      // Preserve any sequence values already reserved by other sessions or sequence caching.
      const floor =
        BigInt(state.last_value ?? candidate.next_id) > BigInt(state.max_id) ? state.last_value : state.max_id;
      await runner.query('SELECT setval($1::regclass, $2::bigint, true)', [owned.sequence, floor]);
    }
  }
}
