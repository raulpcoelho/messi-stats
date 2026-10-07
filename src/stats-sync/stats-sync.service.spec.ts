import { Match } from '../matches/entities/match.entity';
import { Team } from '../teams/entities/team.entity';
import { Competition } from '../competitions/entities/competition.entity';
import { Season } from '../seasons/entities/season.entity';
import { TypeOrmService } from '../database/typeorm.service';
import { parseStatsSource } from './stats-source';
import { StatsSyncService } from './stats-sync.service';
import { Logger } from '@nestjs/common';

const sourceNode = {
  date: '07-10',
  year: '2026',
  season: '2026-2027',
  competition: 'MLS',
  team: 'Inter Miami',
  opponent: 'Columbus',
  homeAway: 'H',
  goals: '0',
  assists: '1',
  scoreTeam: '2',
  scoreOpponent: '0',
  minsPlayed: '90',
  pens: '0',
  started: '1',
  motm: '0',
};
function sourcePayload(nodes = [sourceNode]) {
  return { result: { data: { history: { edges: nodes.map(node => ({ node })) } } } };
}

describe('Stats sync import', () => {
  let service: StatsSyncService;
  let runner: any;
  let database: any;
  let rows: Map<any, any[]>;
  let fetchMock: jest.SpyInstance;
  let logMock: jest.SpyInstance;
  const previousSource = process.env.API_MVSR_APP;

  beforeEach(() => {
    logMock = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    process.env.API_MVSR_APP = 'https://example.test/private-source';
    rows = new Map<any, any[]>([
      [Match, []],
      [Team, []],
      [Season, []],
      [Competition, []],
    ]);
    runner = {
      isTransactionActive: false,
      connect: jest.fn(),
      release: jest.fn(),
      startTransaction: jest.fn(async () => {
        runner.isTransactionActive = true;
      }),
      commitTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      rollbackTransaction: jest.fn(async () => {
        runner.isTransactionActive = false;
      }),
      query: jest.fn(async (sql: string, params: string[]) => {
        if (sql.includes('pg_get_serial_sequence')) return [{ sequence: `${params[0].replace(/"/g, '')}_id_seq` }];
        if (sql.includes('nextval')) return [{ next_id: '1' }];
        if (sql.includes('FROM pg_sequences')) return [{ max_id: '0', last_value: '1' }];
        return [{ locked: true }];
      }),
      manager: {
        find: jest.fn(async entity => [...rows.get(entity)]),
        create: jest.fn((entity, values) => Object.assign(new entity(), values)),
        save: jest.fn(async (entity, values) => {
          for (const value of values) {
            if (!value.id) {
              value.id = rows.get(entity).length + 1;
              rows.get(entity).push(value);
            } else {
              const index = rows.get(entity).findIndex(row => row.id === value.id);
              rows.get(entity)[index] = value;
            }
          }
          return values;
        }),
      },
    };
    const tableNames = new Map<any, string>([
      [Match, 'matches'],
      [Team, 'teams'],
      [Season, 'seasons'],
      [Competition, 'competitions'],
    ]);
    database = {
      createQueryRunner: jest.fn(() => runner),
      getMetadata: jest.fn(entity => ({ tableName: tableNames.get(entity) })),
    };
    service = new StatsSyncService(database as TypeOrmService);
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => sourcePayload(),
    } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
    logMock.mockRestore();
    if (previousSource === undefined) delete process.env.API_MVSR_APP;
    else process.env.API_MVSR_APP = previousSource;
  });

  it('creates missing relations and matches, then performs an idempotent second sync', async () => {
    expect(await service.sync()).toEqual({ fetched: 1, inserted: 1, updated: 0, unchanged: 0 });
    expect(rows.get(Team).map(team => team.name)).toEqual(['Inter Miami', 'Columbus']);
    expect(rows.get(Season)).toHaveLength(1);
    expect(rows.get(Competition)).toHaveLength(1);
    expect(rows.get(Match)[0]).toMatchObject({ goals: 0, teamScore: 2, matchDate: '2026-10-07' });
    expect(await service.sync()).toEqual({ fetched: 1, inserted: 0, updated: 0, unchanged: 1 });
    expect(rows.get(Match)).toHaveLength(1);
    expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
  });

  it('corrects existing stats by date, preserving the row id and unrelated matches', async () => {
    await service.sync();
    rows.get(Match)[0].matchDate = '2026-10-07'; // Postgres date columns return strings.
    const unrelated = { ...rows.get(Match)[0], id: 2, matchDate: '2026-10-06' };
    rows.get(Match).push(unrelated);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => sourcePayload([{ ...sourceNode, goals: '3' }]),
    } as Response);
    expect(await service.sync()).toEqual({ fetched: 1, inserted: 0, updated: 1, unchanged: 0 });
    expect(rows.get(Match)[0]).toMatchObject({ id: 1, goals: 3 });
    expect(rows.get(Match)[1]).toBe(unrelated);
  });

  it.each([
    { ok: false, json: async () => sourcePayload() },
    { ok: true, json: async () => ({ edges: [] }) },
    { ok: true, json: async () => sourcePayload([{ ...sourceNode, goals: 'bad' }]) },
    {
      ok: true,
      json: async () => {
        throw new Error('Private upstream details');
      },
    },
  ])('rejects upstream errors and invalid data before opening a transaction', async response => {
    fetchMock.mockResolvedValue(response as Response);
    await expect(service.sync()).rejects.toMatchObject({ status: 502 });
    expect(database.createQueryRunner).not.toHaveBeenCalled();
  });

  it('handles network failure without exposing private details and allows retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error(process.env.API_MVSR_APP));
    await expect(service.sync()).rejects.toThrow('Unable to fetch valid stats. No data was changed.');
    expect(database.createQueryRunner).not.toHaveBeenCalled();
    expect((await service.sync()).inserted).toBe(1);
  });

  it('rejects a missing or invalid source configuration', async () => {
    delete process.env.API_MVSR_APP;
    await expect(service.sync()).rejects.toMatchObject({ status: 503 });
    process.env.API_MVSR_APP = 'file:///tmp/source';
    await expect(service.sync()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rolls back the entire transaction on a write failure and releases the connection', async () => {
    runner.manager.save.mockRejectedValueOnce(new Error('Private database details'));
    await expect(service.sync()).rejects.toThrow('Unable to save stats. The update was rolled back.');
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.commitTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('returns a safe database code and stage without exposing SQL, values, or credentials', async () => {
    const failure = Object.assign(new Error('secret connection and SQL values'), {
      driverError: { code: '23505', detail: 'private row values' },
      query: 'private SQL',
      parameters: ['secret'],
    });
    runner.manager.save.mockRejectedValueOnce(failure);
    let caught: any;
    try {
      await service.sync();
    } catch (error) {
      caught = error;
    }
    expect(caught.getResponse()).toMatchObject({ stage: 'save_teams', databaseCode: '23505' });
    expect(logMock).toHaveBeenCalledWith({ event: 'stats_sync_failed', stage: 'save_teams', databaseCode: '23505' });
    expect(JSON.stringify(caught.getResponse())).not.toContain('secret');
    expect(JSON.stringify(logMock.mock.calls)).not.toContain('private');
  });

  it('reports a connection failure without claiming a rollback and permits a later retry', async () => {
    runner.connect.mockRejectedValueOnce(Object.assign(new Error('private host'), { code: 'ECONNRESET' }));
    await expect(service.sync()).rejects.toThrow('Unable to connect to the database. No data was changed.');
    expect(runner.rollbackTransaction).not.toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalledTimes(1);
    expect((await service.sync()).inserted).toBe(1);
  });

  it('discards the client if rollback fails and preserves the original failure diagnostics', async () => {
    const connection = { end: jest.fn().mockResolvedValue(undefined) };
    runner.connect.mockResolvedValue(connection);
    runner.manager.save.mockRejectedValueOnce({ driverError: { code: '23505' } });
    runner.rollbackTransaction.mockRejectedValueOnce({ code: 'ECONNRESET' });
    let caught: any;
    try {
      await service.sync();
    } catch (error) {
      caught = error;
    }
    expect(caught.getStatus()).toBe(503);
    expect(caught.getResponse()).toMatchObject({ stage: 'save_teams', databaseCode: '23505' });
    expect(caught.message).not.toContain('was rolled back');
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('closes the client if release fails, without masking a committed update', async () => {
    const connection = { end: jest.fn().mockResolvedValue(undefined) };
    runner.connect.mockResolvedValue(connection);
    runner.release.mockImplementationOnce(async () => {
      runner.isReleased = true;
      throw { code: 'ECONNRESET' };
    });
    expect((await service.sync()).inserted).toBe(1);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(logMock).toHaveBeenCalledWith({
      event: 'stats_sync_cleanup_failed',
      stage: 'release',
      databaseCode: 'ECONNRESET',
    });
  });

  it('sets local server timeouts before querying and writing', async () => {
    await service.sync();
    expect(runner.query.mock.calls.slice(0, 3)).toEqual([
      ["SET LOCAL statement_timeout = '15s'"],
      ["SET LOCAL lock_timeout = '3s'"],
      ["SET LOCAL idle_in_transaction_session_timeout = '20s'"],
    ]);
  });

  it('aligns stale ID sequences before inserting matches and related records', async () => {
    const originalQuery = runner.query.getMockImplementation();
    runner.query.mockImplementation((sql, params) =>
      sql.includes('FROM pg_sequences') ? [{ max_id: '100', last_value: '1' }] : originalQuery(sql, params),
    );
    await service.sync();
    expect(runner.query.mock.calls.filter(([sql]) => sql.includes('setval'))).toEqual([
      ['SELECT setval($1::regclass, $2::bigint, true)', ['teams_id_seq', '100']],
      ['SELECT setval($1::regclass, $2::bigint, true)', ['seasons_id_seq', '100']],
      ['SELECT setval($1::regclass, $2::bigint, true)', ['competitions_id_seq', '100']],
      ['SELECT setval($1::regclass, $2::bigint, true)', ['matches_id_seq', '100']],
    ]);
  });

  it('preserves sequence reservations higher than the largest existing ID during repair', async () => {
    const originalQuery = runner.query.getMockImplementation();
    runner.query.mockImplementation((sql, params) =>
      sql.includes('FROM pg_sequences') ? [{ max_id: '100', last_value: '300' }] : originalQuery(sql, params),
    );
    await service.sync();
    expect(runner.query.mock.calls.filter(([sql]) => sql.includes('setval')).map(([, params]) => params[1])).toEqual([
      '300',
      '300',
      '300',
      '300',
    ]);
  });

  it('does not reset a healthy sequence or inspect sequences when no rows are inserted', async () => {
    const originalQuery = runner.query.getMockImplementation();
    runner.query.mockImplementation((sql, params) => {
      if (sql.includes('nextval')) return [{ next_id: '301' }];
      if (sql.includes('FROM pg_sequences')) return [{ max_id: '100', last_value: '301' }];
      return originalQuery(sql, params);
    });
    await service.sync();
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('setval'))).toBe(false);
    runner.query.mockClear();
    await service.sync();
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('nextval'))).toBe(false);
  });

  it('reports a remaining unique constraint conflict without ignoring it or retrying writes', async () => {
    runner.manager.save.mockRejectedValueOnce({ driverError: { code: '23505', constraint: 'matches_date_unique' } });
    let caught: any;
    try {
      await service.sync();
    } catch (error) {
      caught = error;
    }
    expect(caught.getResponse()).toMatchObject({ databaseCode: '23505', databaseConstraint: 'matches_date_unique' });
    expect(runner.manager.save).toHaveBeenCalledTimes(1);
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('corrects a single one-day date shift in an otherwise matching snapshot, keeping its ID', async () => {
    const otherNode = { ...sourceNode, date: '01-10', opponent: 'Other opponent' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => sourcePayload([sourceNode, otherNode]) } as Response);
    await service.sync();
    const previousId = rows.get(Match)[0].id;
    rows.get(Match)[0].matchDate = '2026-10-06';
    runner.query.mockClear();
    expect(await service.sync()).toEqual({ fetched: 2, inserted: 0, updated: 1, unchanged: 1 });
    expect(rows.get(Match)).toHaveLength(2);
    expect(rows.get(Match)[0]).toMatchObject({ id: previousId, matchDate: '2026-10-07' });
    expect(runner.query.mock.calls.some(([sql]) => sql.includes('nextval'))).toBe(false);
  });

  it.each(['partial', 'different'])('retains unmatched games when the source is %s', async mode => {
    const otherNode = { ...sourceNode, date: '01-10', opponent: 'Other opponent' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => sourcePayload([sourceNode, otherNode]) } as Response);
    await service.sync();
    rows.get(Match)[0].matchDate = '2026-10-06';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => sourcePayload(mode === 'partial' ? [sourceNode] : [{ ...sourceNode, goals: '2' }, otherNode]),
    } as Response);
    expect((await service.sync()).inserted).toBe(1);
    expect(rows.get(Match).map(m => m.matchDate)).toContain('2026-10-06');
  });

  it('rejects a database lock conflict without writing', async () => {
    runner.query.mockResolvedValue([{ locked: false }]);
    await expect(service.sync()).rejects.toMatchObject({ status: 409 });
    expect(runner.manager.save).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate dates already in the database', async () => {
    const [match] = parseStatsSource(sourcePayload());
    rows.set(Match, [match, match]);
    await expect(service.sync()).rejects.toMatchObject({ status: 409 });
    expect(runner.manager.save).not.toHaveBeenCalled();
    expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping requests within the same instance', async () => {
    let resolveFetch: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise(resolve => {
        resolveFetch = resolve;
      }),
    );
    const first = service.sync();
    await expect(service.sync()).rejects.toMatchObject({ status: 409 });
    resolveFetch({ ok: true, json: async () => sourcePayload() } as Response);
    expect((await first).inserted).toBe(1);
  });
});
