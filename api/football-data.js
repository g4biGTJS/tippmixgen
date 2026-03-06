// api/football-data.js – football-data.org ingyenes API
// Regisztráció: https://www.football-data.org/client/register
// Ingyenes: 10 liga, 10 req/perc, nincs napi limit
// Env: FOOTBALL_DATA_KEY (vagy hardcode lentebb)
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const BASE    = 'https://api.football-data.org/v4';
const API_KEY = process.env.FOOTBALL_DATA_KEY || 'b1d5e1b7aa48482a863f1bd67bbba34d';

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

// Ingyenes ligák az API-n
const FREE_LEAGUES = [
  { id: 2021, name: 'Premier League',    country: 'England' },
  { id: 2002, name: 'Bundesliga',        country: 'Germany' },
  { id: 2014, name: 'La Liga',           country: 'Spain' },
  { id: 2019, name: 'Serie A',           country: 'Italy' },
  { id: 2015, name: 'Ligue 1',           country: 'France' },
  { id: 2001, name: 'Champions League',  country: 'Europe' },
  { id: 2018, name: 'European Championship', country: 'Europe' },
  { id: 2000, name: 'FIFA World Cup',    country: 'World' },
  { id: 2003, name: 'Eredivisie',        country: 'Netherlands' },
  { id: 2017, name: 'Primeira Liga',     country: 'Portugal' },
];

// ─── API hívás ────────────────────────────────────────────────────────────────

async function fdGet(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: {
      'X-Auth-Token': API_KEY,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(12000),
  });

  if (res.status === 429) throw new Error('Túl sok kérés – várj egy percet');
  if (res.status === 403) throw new Error('Érvénytelen API kulcs');
  if (!res.ok) throw new Error(`football-data.org HTTP ${res.status}`);

  return res.json();
}

// ─── Csapat keresése ──────────────────────────────────────────────────────────
// Több ligában is keresi egymás után amíg megtalálja

async function findTeam(name) {
  const cleanName = name.trim().toLowerCase();

  // Megpróbáljuk az összes ingyenes ligában keresni
  for (const league of FREE_LEAGUES) {
    try {
      const data = await fdGet(`/competitions/${league.id}/teams`);
      const teams = data.teams || [];
      const found = teams.find(t =>
        t.name.toLowerCase().includes(cleanName) ||
        t.shortName?.toLowerCase().includes(cleanName) ||
        t.tla?.toLowerCase() === cleanName ||
        cleanName.includes(t.shortName?.toLowerCase() || '')
      );
      if (found) return { team: found, leagueId: league.id, leagueName: league.name };
    } catch {
      continue; // következő liga
    }
  }

  throw new Error(`Csapat nem található az ingyenes ligákban: "${name}". Ellenőrizd a nevet, vagy lehet hogy a csapat ligája nem elérhető ingyen (pl. magyar bajnokság).`);
}

// ─── Csapat utolsó meccserei ──────────────────────────────────────────────────

async function getTeamMatches(teamId, limit = 10) {
  try {
    const data = await fdGet(`/teams/${teamId}/matches?status=FINISHED&limit=${limit}`);
    const matches = data.matches || [];
    return matches
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, limit)
      .map(m => ({
        date:      m.utcDate?.split('T')[0] ?? '',
        home:      m.homeTeam?.name ?? '',
        away:      m.awayTeam?.name ?? '',
        homeGoals: m.score?.fullTime?.home ?? 0,
        awayGoals: m.score?.fullTime?.away ?? 0,
        winner:    m.score?.winner === 'HOME_TEAM' ? 'home'
                 : m.score?.winner === 'AWAY_TEAM' ? 'away' : 'draw',
        league:    m.competition?.name ?? '',
      }));
  } catch {
    return [];
  }
}

// ─── H2H ─────────────────────────────────────────────────────────────────────

async function getH2H(team1Id, team2Id) {
  try {
    // football-data.org H2H egy konkrét meccshez van, de a csapatok meccslistájából ki tudjuk szűrni
    const [m1, m2] = await Promise.all([
      getTeamMatches(team1Id, 40),
      getTeamMatches(team2Id, 40),
    ]);

    // Azok a meccsek ahol mindkét csapat szerepel
    const h2h = m1.filter(m =>
      (m.home.toLowerCase().includes('') && m.away.toLowerCase().includes('')) // placeholder
    );

    // Egyszerűbb: csak a team1 meccsei ahol a team2 is szerepel
    const team2Matches = m2.map(m => `${m.home}|${m.away}|${m.date}`);
    const combined = m1.filter(m =>
      team2Matches.includes(`${m.home}|${m.away}|${m.date}`)
    );

    return combined.slice(0, 8);
  } catch {
    return [];
  }
}

// ─── Szezon statisztikák a csapat meccseiből számolva ─────────────────────────

function calcStats(matches, teamName) {
  if (!matches.length) return null;
  let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0, cs = 0, noScore = 0;

  for (const m of matches) {
    const isHome = m.home === teamName;
    const mGF = isHome ? m.homeGoals : m.awayGoals;
    const mGA = isHome ? m.awayGoals : m.homeGoals;
    gf += mGF; ga += mGA;
    if (m.winner === 'draw')                                                 draws++;
    else if ((isHome && m.winner === 'home') || (!isHome && m.winner === 'away')) wins++;
    else                                                                      losses++;
    if (mGA === 0) cs++;
    if (mGF === 0) noScore++;
  }

  const n = matches.length;
  return {
    played:          n,
    wins,
    draws,
    losses,
    goalsFor:        gf,
    goalsAgainst:    ga,
    avgGoalsFor:     (gf / n).toFixed(2),
    avgGoalsAgainst: (ga / n).toFixed(2),
    cleanSheets:     cs,
    failedToScore:   noScore,
    form:            matches.slice(0, 5).map(m => {
      const isHome = m.home === teamName;
      if (m.winner === 'draw') return 'D';
      return (isHome && m.winner === 'home') || (!isHome && m.winner === 'away') ? 'W' : 'L';
    }).join(''),
  };
}

// ─── Aggregált statisztikák ───────────────────────────────────────────────────

function calcAgg(matches, teamName) {
  if (!matches.length) return null;
  let gf = 0, ga = 0, over25 = 0, btts = 0;
  for (const m of matches) {
    const isHome = m.home === teamName;
    const mGF = isHome ? m.homeGoals : m.awayGoals;
    const mGA = isHome ? m.awayGoals : m.homeGoals;
    gf += mGF; ga += mGA;
    if (mGF + mGA > 2.5) over25++;
    if (mGF > 0 && mGA > 0) btts++;
  }
  const n = matches.length;
  return {
    avgGoalsFor:     +(gf / n).toFixed(2),
    avgGoalsAgainst: +(ga / n).toFixed(2),
    over25Pct:       Math.round(over25 / n * 100),
    bttsPct:         Math.round(btts   / n * 100),
    cleanSheetPct:   Math.round(matches.filter(m => {
      const isHome = m.home === teamName;
      return (isHome ? m.awayGoals : m.homeGoals) === 0;
    }).length / n * 100),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return jsonRes({ error: 'Csak POST kérés engedélyezett.' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return jsonRes({ error: 'Érvénytelen JSON.' }, 400); }

  const { homeTeam, awayTeam } = body;
  if (!homeTeam || !awayTeam) {
    return jsonRes({ error: 'A hazai és vendég csapat neve kötelező.' }, 400);
  }

  if (!API_KEY) {
    return jsonRes({
      noData: true,
      message: 'FOOTBALL_DATA_KEY nincs beállítva.',
      homeTeam: { name: homeTeam, form: '', stats: null, agg: null },
      awayTeam: { name: awayTeam, form: '', stats: null, agg: null },
      lastMatches: { home: [], away: [] },
      h2h: [], nextFixture: null, injuries: [],
    });
  }

  try {
    // Csapatok keresése
    const [homeResult, awayResult] = await Promise.all([
      findTeam(homeTeam),
      findTeam(awayTeam),
    ]);

    const homeId = homeResult.team.id;
    const awayId = awayResult.team.id;

    // Meccsek lekérése
    const [homeMatches, awayMatches] = await Promise.all([
      getTeamMatches(homeId, 10),
      getTeamMatches(awayId, 10),
    ]);

    // H2H: szűrjük ki az egymás elleni meccseket
    const homeName = homeResult.team.name;
    const awayName = awayResult.team.name;
    const h2h = homeMatches.filter(m =>
      m.home === awayName || m.away === awayName
    ).slice(0, 6);

    return jsonRes({
      homeTeam: {
        id:    homeId,
        name:  homeName,
        logo:  homeResult.team.crest,
        form:  calcStats(homeMatches, homeName)?.form || '',
        stats: calcStats(homeMatches, homeName),
        agg:   calcAgg(homeMatches, homeName),
        league: homeResult.leagueName,
      },
      awayTeam: {
        id:    awayId,
        name:  awayName,
        logo:  awayResult.team.crest,
        form:  calcStats(awayMatches, awayName)?.form || '',
        stats: calcStats(awayMatches, awayName),
        agg:   calcAgg(awayMatches, awayName),
        league: awayResult.leagueName,
      },
      lastMatches: { home: homeMatches, away: awayMatches },
      h2h,
      nextFixture: null,
      injuries:    [],
    });

  } catch (err) {
    console.error('[football-data]', err.message);
    // Hiba esetén sem állunk le – AI tipp odds alapján folytatódik
    return jsonRes({
      noData:  true,
      message: err.message,
      homeTeam: { name: homeTeam, form: '', stats: null, agg: null },
      awayTeam: { name: awayTeam, form: '', stats: null, agg: null },
      lastMatches: { home: [], away: [] },
      h2h: [], nextFixture: null, injuries: [],
    });
  }
}
