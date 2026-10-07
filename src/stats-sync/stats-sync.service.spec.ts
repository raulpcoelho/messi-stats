import { Match } from '../matches/entities/match.entity';
import { Team } from '../teams/entities/team.entity';
import { Competition } from '../competitions/entities/competition.entity';
import { Season } from '../seasons/entities/season.entity';
import { TypeOrmService } from '../database/typeorm.service';
import { parseStatsSource } from './stats-source';
import { StatsSyncService } from './stats-sync.service';

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
  const previousSource = process.env.API_MVSR_APP;

  beforeEach(() => {
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
      query: jest.fn().mockResolvedValue([{ locked: true }]),
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
    database = { createQueryRunner: jest.fn(() => runner) };
    service = new StatsSyncService(database as TypeOrmService);
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => sourcePayload(),
    } as Response);
  });

  afterEach(() => {
    fetchMock.mockRestore();
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
