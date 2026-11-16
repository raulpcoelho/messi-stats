-- Manual repair for the confirmed duplicate in the 1,186-match API snapshot.
-- Run the entire script in the intended PostgreSQL database.
-- Any failed check aborts the transaction without deleting a match.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
SELECT pg_advisory_xact_lock(1297306707);
LOCK TABLE matches IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate_match matches%ROWTYPE;
  canonical_match matches%ROWTYPE;
  before_count bigint;
  after_count bigint;
  deleted_count integer;
BEGIN
  SELECT COUNT(*) INTO before_count FROM matches;

  SELECT m.* INTO STRICT duplicate_match
  FROM matches m
  JOIN teams team ON team.id = m.team_id
  JOIN teams opponent ON opponent.id = m.opponent_id
  JOIN competitions competition ON competition.id = m.competition_id
  JOIN seasons season ON season.id = m.season_id
  WHERE m.match_date = DATE '2020-08-16'
    AND team.name = 'Barcelona'
    AND opponent.name = 'Bayern Munich'
    AND competition.name = 'Champions League'
    AND season.name = '2019-2020'
    AND m.team_score = 2 AND m.opponent_score = 8;

  SELECT m.* INTO STRICT canonical_match
  FROM matches m
  WHERE m.match_date = DATE '2020-08-14'
    AND m.team_id = duplicate_match.team_id
    AND m.opponent_id = duplicate_match.opponent_id
    AND m.competition_id = duplicate_match.competition_id
    AND m.season_id = duplicate_match.season_id;

  IF (to_jsonb(duplicate_match) - ARRAY['id', 'match_date', 'created_at', 'updated_at'])
     IS DISTINCT FROM
     (to_jsonb(canonical_match) - ARRAY['id', 'match_date', 'created_at', 'updated_at']) THEN
    RAISE EXCEPTION 'The two matches differ in fields other than date. No repair applied.';
  END IF;

  DELETE FROM matches WHERE id = duplicate_match.id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  SELECT COUNT(*) INTO after_count FROM matches;
  IF deleted_count <> 1 OR after_count <> before_count - 1 THEN
    RAISE EXCEPTION 'Unexpected row count. No repair applied.';
  END IF;

  RAISE NOTICE 'Removed duplicate id=%, preserved id=%, matches before=%, after=%',
    duplicate_match.id, canonical_match.id, before_count, after_count;
END;
$$;

COMMIT;
