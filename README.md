# Lionel Messi Stats API

This API provides detailed statistics for all matches played by Lionel Messi. You can filter the data by year, opponents, season, competition, and more to get specific insights. The data is updated regularly as Messi plays new matches.

## API URL

The API is accessible at: [https://www.messistats.info](https://www.messistats.info)

## Endpoints

### Matches (`/matches`)

Retrieve statistics of all matches in Messi's career. Can be filtered by opponents, season, year, competition, among others.

**Example Request:**

GET /matches?year=2010&opponent=Real%20Madrid

**Example Response:**

```json
[
  {
    "matchDate": "2010-11-29",
    "season": "2010-2011",
    "competition": "La Liga",
    "home": true,
    "team": "Barcelona",
    "opponent": "Real Madrid",
    "teamScore": 5,
    "opponentScore": 0,
    "goals": 0,
    "assists": 2,
    "started": true,
    "minutesPlayed": 90,
    "pensScored": 0,
    "pensMissed": 0,
    "hatTricks": 0,
    "freeKicks": 0,
    "insideBox": 0,
    "outsideBox": 0,
    "left": 0,
    "right": 0,
    "head": 0,
    "other": 0,
    "successfulDribbles": 9,
    "motm": true
  },
  {
    "matchDate": "2010-04-10",
    "season": "2009-2010",
    "competition": "La Liga",
    "home": false,
    "team": "Barcelona",
    "opponent": "Real Madrid",
    "teamScore": 2,
    "opponentScore": 0,
    "goals": 1,
    "assists": 0,
    "started": true,
    "minutesPlayed": 90,
    "pensScored": 0,
    "pensMissed": 0,
    "hatTricks": 0,
    "freeKicks": 0,
    "insideBox": 1,
    "outsideBox": 0,
    "left": 0,
    "right": 1,
    "head": 0,
    "other": 0,
    "successfulDribbles": 1,
    "motm": false
  }
]
```

### Totals (`/totals`)

Retrieve total statistics. Can also be filtered by various parameters.

**Example Request:**

GET /totals?year=2022&competition=World%20Cup

**Example Response:**

```json
{
  "totalGoals": 7,
  "totalAssists": 3,
  "totalMatches": 7,
  "totalMinutes": 690,
  "homeMatches": 0,
  "awayMatches": 7,
  "matchesWon": 4,
  "matchesLost": 1,
  "matchesStarted": 7,
  "totalPensScored": 4,
  "totalPensMissed": 1,
  "totalHatTricks": 0,
  "totalFreeKicks": 0,
  "totalInsideBox": 2,
  "totalOutsideBox": 1,
  "totalLeft": 6,
  "totalRight": 1,
  "totalHeaded": 0,
  "totalOtherBodyPart": 0,
  "totalSuccessfulDribbles": 15,
  "totalMotm": 2
}
```

## Examples

- Stats for all Messi games against Real Madrid in La Liga: https://www.messistats.info/matches?competition=La%20Liga&opponent=Real%20Madrid
- Messi's total stats against Real Madrid in La Liga: https://www.messistats.info/totals?competition=La%20Liga&opponent=Real%20Madrid
- Messi's stats in 2012: https://www.messistats.info/totals?year=2012
- Messi's 2018/2019 season stats: https://www.messistats.info/totals?season=2018-2019
- Messi's total stats in the Champions League: https://www.messistats.info/totals?competition=Champions%20League
- If you remember a game by a specific date: https://www.messistats.info/matches?matchDate=2011-05-28
- Messi's stats on matches he didn't start: https://www.messistats.info/totals?started=false
- Messi's stats from 2009 to 2019: https://www.messistats.info/totals/years?startYear=2009&endYear=2019

## Updating stats from the page

On the deployed API server, set `API_MVSR_APP` to the stats source URL used by the local import skill and `STATS_SYNC_TOKEN` to a strong, private update key. The existing `TYPEORM_*` settings must point to the remote database. Redeploy after configuring these environment variables; neither secret belongs in the public JavaScript or HTML.

Click the **Lionel Messi Stats** page title four times, with less than two seconds between clicks. The hidden **Update stats** button appears for the current page session, including on mobile. Click it, enter your update key, and choose **Update now**. The page shows the number of new, corrected, and unchanged matches and refreshes the displayed stats.

The authenticated `POST /admin/stats/sync` endpoint fetches and validates the source on the server, creates missing teams/seasons/competitions, and inserts new matches or corrects existing stats using the match date as the identity, consistent with the local importer. A transaction rolls back the whole import if a write fails. A PostgreSQL transaction lock prevents concurrent imports across server instances. Empty or ambiguous source responses, malformed records, and duplicate match dates are rejected. Existing matches absent from the source are retained. This flow does not require data migrations or `add-matches.json`.

Without `STATS_SYNC_TOKEN`, the endpoint is disabled. The key is sent only in the request's Authorization header and is not saved in browser storage. The source request has a 20-second timeout; the hosting provider's function timeout must also accommodate the database import.

## License

This project is licensed under the Apache 2.0 License - see the [LICENSE](./LICENSE) file for details.

## Contact

For any inquiries, please contact Raul Coelho at rpc3@cin.ufpe.br.

<a href="https://www.flaticon.com/br/icones-gratis/coroa" title="icon crown">Icon created by Good Ware - Flaticon</a>
