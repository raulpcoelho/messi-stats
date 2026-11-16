import { parseStatsSource } from './stats-source';

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
  successfulDribbles: '-',
};

function sourcePayload(nodes = [sourceNode]) {
  return { result: { data: { history: { edges: nodes.map(node => ({ node })) } } } };
}

describe('Stats source validation', () => {
  it('maps the source fields, preserves zero and null, and uses a UTC match date', () => {
    const payload = sourcePayload();
    const before = JSON.stringify(payload);
    const [match] = parseStatsSource(payload);
    expect(match).toMatchObject({
      teamScore: 2,
      opponentScore: 0,
      minutesPlayed: 90,
      pensScored: 0,
      goals: 0,
      assists: 1,
      successfulDribbles: null,
      home: true,
      started: true,
      motm: false,
    });
    expect(match.matchDate.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(JSON.stringify(payload)).toBe(before);
  });

  it('supports neutral venues and numeric zero', () => {
    const [match] = parseStatsSource(sourcePayload([{ ...sourceNode, homeAway: 'N', goals: 0 } as any]));
    expect(match.home).toBe(false);
    expect(match.goals).toBe(0);
  });

  it('maps the current page-data matches format using the same validation as legacy edges', () => {
    const payload = { result: { pageContext: { matches: [sourceNode] } } };
    const before = JSON.stringify(payload);
    expect(parseStatsSource(payload)).toEqual(parseStatsSource(sourcePayload()));
    expect(JSON.stringify(payload)).toBe(before);
  });

  it.each([null, {}, [], [null], [{ node: sourceNode }], [{ ...sourceNode, goals: 'bad' }], [sourceNode, sourceNode]])(
    'rejects invalid current-format matches without bypassing validation',
    matches => {
      expect(() => parseStatsSource({ result: { pageContext: { matches } } })).toThrow();
    },
  );

  it('rejects ambiguous responses containing both supported formats', () => {
    const payload = {
      ...sourcePayload(),
      result: { ...sourcePayload().result, pageContext: { matches: [sourceNode] } },
    };
    expect(() => parseStatsSource(payload)).toThrow();
  });

  it('does not accept an arbitrary matches array outside the known page-data path', () => {
    expect(() => parseStatsSource({ matches: [sourceNode] })).toThrow();
  });

  it('preserves unknown boolean stats instead of changing them to false', () => {
    const [match] = parseStatsSource(sourcePayload([{ ...sourceNode, motm: null, started: '-' }]));
    expect(match.motm).toBeNull();
    expect(match.started).toBeNull();
  });

  it.each([
    {},
    { edges: [] },
    { edges: {} },
    { edges: [{ node: null }] },
    { edges: [{ node: sourceNode }], other: { edges: [{ node: sourceNode }] } },
    { nested: [{ edges: [] }, { edges: [] }] },
  ])('rejects an absent, empty, invalid, or ambiguous edges array', payload => {
    expect(() => parseStatsSource(payload)).toThrow();
  });

  it.each([
    { date: '31-02' },
    { year: 'bad' },
    { goals: '2oops' },
    { goals: '-1' },
    { assists: '1.5' },
    { homeAway: 'bad' },
    { started: '2' },
    { opponent: '' },
    { team: 'x'.repeat(31) },
  ])('rejects malformed match data before an import', invalid => {
    expect(() => parseStatsSource(sourcePayload([{ ...sourceNode, ...invalid }]))).toThrow();
  });

  it('rejects duplicate match dates', () => {
    expect(() => parseStatsSource(sourcePayload([sourceNode, sourceNode]))).toThrow();
  });
});
