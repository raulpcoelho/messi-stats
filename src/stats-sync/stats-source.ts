import { MatchDto } from '../matches/dto/match.dto';

const integerFields = {
  teamScore: 'scoreTeam',
  opponentScore: 'scoreOpponent',
  minutesPlayed: 'minsPlayed',
  pensScored: 'pens',
  goals: 'goals',
  assists: 'assists',
  pensMissed: 'pensMissed',
  hatTricks: 'hatTricks',
  freeKicks: 'freeKicks',
  insideBox: 'insideBox',
  outsideBox: 'outsideBox',
  left: 'left',
  right: 'right',
  head: 'head',
  other: 'other',
  successfulDribbles: 'successfulDribbles',
} as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '' || value === '-';
}

function parseInteger(value: unknown): number | null {
  if (isMissing(value)) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
    throw new Error('Invalid integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2147483647) {
    throw new Error('Invalid integer');
  }
  return parsed;
}

function parseFlag(value: unknown): boolean {
  if (isMissing(value) || value === '0' || value === 0 || value === false) return false;
  if (value === '1' || value === 1 || value === true) return true;
  throw new Error('Invalid flag');
}

// Discover the single edges array without depending on the upstream envelope.
export function parseStatsSource(payload: unknown): MatchDto[] {
  const candidates: unknown[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isObject(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (key === 'edges') candidates.push(nested);
        else visit(nested);
      }
    }
  }
  visit(payload);
  if (candidates.length !== 1 || !Array.isArray(candidates[0]) || candidates[0].length === 0) {
    throw new Error('Expected a single nonempty edges array');
  }

  const dates = new Set<string>();
  return candidates[0].map(edge => {
    if (!isObject(edge) || !isObject(edge.node)) throw new Error('Invalid match node');
    const node = edge.node;
    const dto = new MatchDto();
    for (const field of ['season', 'competition', 'team', 'opponent'] as const) {
      const value = node[field];
      const maxLength = field === 'season' ? 11 : 30;
      if (typeof value !== 'string' || !value.trim() || value === '-' || value.length > maxLength) {
        throw new Error('Invalid match name');
      }
      dto[field] = value;
    }

    if (typeof node.date !== 'string' || !/^\d{2}-\d{2}$/.test(node.date) || !/^\d{4}$/.test(String(node.year))) {
      throw new Error('Invalid match date');
    }
    const [day, month] = node.date.split('-');
    const date = `${node.year}-${month}-${day}`;
    dto.matchDate = new Date(`${date}T00:00:00.000Z`);
    if (
      !Number.isFinite(dto.matchDate.getTime()) ||
      dto.matchDate.toISOString().slice(0, 10) !== date ||
      dates.has(date)
    ) {
      throw new Error('Invalid or duplicate match date');
    }
    dates.add(date);

    for (const [field, source] of Object.entries(integerFields)) dto[field] = parseInteger(node[source]);
    if (!['H', 'A', 'N'].includes(String(node.homeAway))) throw new Error('Invalid venue');
    dto.home = node.homeAway === 'H';
    dto.started = parseFlag(node.started);
    dto.motm = parseFlag(node.motm);
    return dto;
  });
}
