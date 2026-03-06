// api/football-data.js – API-Football ingyenes tier kompatibilis
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const BASE    = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY || '1cd704dff5d7c89e4f961c3d902930f7';

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

// ─── API hívás ────────────────────────────────────────────────────────────────

async function afoot(endpoint, params = {}) {
  const url = new URL(`${BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    headers: { 'x-apisports-key': API_KEY },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  const json = await res.json();

  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(Object.values(json.errors).join(', '));
  }

  return json.response ?? [];
}

// ─── Csapat keresés ───────────────────────────────────────────────────────────

async function findTeam(name) {
  // Ékezetek és speciális karakterek eltávolítása – API csak a-z és szóközt fogad el
  const clean = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const results = await afoot('/teams', { search: clean });
  if (!results.length) throw new Error(`Csapat nem található: "${name}"`);

  const exact = results.find(r =>
    r.team.name.toLowerCase().includes(clean.toLowerCase())
  );
  return (exact || results[0]).team;
}

// ─── Aktuális szezon ──────────────────────────────────────────────────────────

function currentSeason() {
  const now = new Date();
  return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
}

// ─── Meccsek lekérése (free tier: season + team, nincs "last" paraméter) ──────

async function getMatches(teamId, season) {
  try {
    const res = await afoot('/fixtures', {
      team:   teamId,
      season: season,
      status: 'FT',
    });
    return res
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, 10)
      .map(r => ({
        date:      r.fixture.date?.split('T')[0] ?? '',
        home:      r.teams.home.name,
        away:      r.teams.away.name,
        homeGoals: r.goals.home ?? 0,
        awayGoals: r.goals.away ?? 0,
        winner:    r.teams.home.winner ? 'home' : r.teams.away.winner ? 'away' : 'draw',
        league:    r.league?.name   ?? '',
        leagueId:  r.league?.id     ?? null,
        season:    r.league?.season ?? season,
      }));
  } catch {
    return [];
  }
}

// ─── H2H ─────────────────────────────────────────────────────────────────────

async function getH2H(id1, id2) {
  try {
    const res = await afoot('/fixtures/headtohead', {
      h2h:    `${id1}-${id2}`,
      status: 'FT',
    });
    return res
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, 8)
      .map(r => ({
        date:      r.fixture.date?.split('T')[0] ?? '',
        home:      r.teams.home.name,
        away:      r.teams.away.name,
        homeGoals: r.goals.home ?? 0,
        awayGoals: r.goals.away ?? 0,
        winner:    r.teams.home.winner ? 'home' : r.teams.away.winner ? 'away' : 'draw',
        league:    r.league?.name ?? '',
      }));
  } catch {
    return [];
  }
}

// ─── Szezon statisztikák ──────────────────────────────────────────────────────

async function getSeasonStats(teamId, leagueId, season) {
  try {
    const res = await afoot('/teams/statistics', {
      team: teamId, league: leagueId, season,
    });
    if (!res || Array.isArray(res)) return null;
    return {
      played:          res.fixtures?.played?.total        ?? 0,
      wins:            res.fixtures?.wins?.total          ?? 0,
      draws:           res.fixtures?.draws?.total         ?? 0,
      losses:          res.fixtures?.loses?.total         ?? 0,
      goalsFor:        res.goals?.for?.total?.total       ?? 0,
      goalsAgainst:    res.goals?.against?.total?.total   ?? 0,
      avgGoalsFor:     res.goals?.for?.average?.total     ?? '0',
      avgGoalsAgainst: res.goals?.against?.average?.total ?? '0',
      cleanSheets:     res.clean_sheet?.total             ?? 0,
      failedToScore:   res.failed_to_score?.total         ?? 0,
      form:            res.form                           ?? '',
    };
  } catch {
    return null;
  }
}

// ─── Forma string ─────────────────────────────────────────────────────────────

function calcForm(matches, teamName) {
  if (!matches.length) return '';
  return matches.slice(0, 5).map(m => {
    const isHome = m.home === teamName;
    if (m.winner === 'draw') return 'D';
    return (isHome && m.winner === 'home') || (!isHome && m.winner === 'away') ? 'W' : 'L';
  }).join('');
}

// ─── Aggregált adatok az utolsó meccsekből ────────────────────────────────────

function aggregateMatches(matches, teamName) {
  if (!matches.length) return null;
  let gf = 0, ga = 0, over25 = 0, btts = 0, cs = 0;
  for (const m of matches) {
    const isHome = m.home === teamName;
    const mGF = isHome ? m.homeGoals : m.awayGoals;
    const mGA = isHome ? m.awayGoals : m.homeGoals;
    gf += mGF; ga += mGA;
    if (mGF + mGA > 2.5) over25++;
    if (mGF > 0 && mGA > 0) btts++;
    if (mGA === 0) cs++;
  }
  const n = matches.length;
  return {
    avgGoalsFor:     +(gf / n).toFixed(2),
    avgGoalsAgainst: +(ga / n).toFixed(2),
    over25Pct:       Math.round(over25 / n * 100),
    bttsPct:         Math.round(btts   / n * 100),
    cleanSheetPct:   Math.round(cs     / n * 100),
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

  try {
    const season = currentSeason();

    // Csapatok azonosítása
    const [homeData, awayData] = await Promise.all([
      findTeam(homeTeam),
      findTeam(awayTeam),
    ]);

    // Meccsek + H2H párhuzamosan
    const [homeMatches, awayMatches, h2h] = await Promise.all([
      getMatches(homeData.id, season),
      getMatches(awayData.id, season),
      getH2H(homeData.id, awayData.id),
    ]);

    // Szezon statisztikák
    const leagueId = homeMatches[0]?.leagueId || awayMatches[0]?.leagueId || null;
    let homeStats = null, awayStats = null;
    if (leagueId) {
      [homeStats, awayStats] = await Promise.all([
        getSeasonStats(homeData.id, leagueId, season),
        getSeasonStats(awayData.id, leagueId, season),
      ]);
    }

    return jsonRes({
      homeTeam: {
        id:    homeData.id,
        name:  homeData.name,
        logo:  homeData.logo,
        form:  calcForm(homeMatches, homeData.name),
        stats: homeStats,
        agg:   aggregateMatches(homeMatches, homeData.name),
      },
      awayTeam: {
        id:    awayData.id,
        name:  awayData.name,
        logo:  awayData.logo,
        form:  calcForm(awayMatches, awayData.name),
        stats: awayStats,
        agg:   aggregateMatches(awayMatches, awayData.name),
      },
      lastMatches: { home: homeMatches, away: awayMatches },
      h2h,
      nextFixture: null,
      injuries:    [],
    });

  } catch (err) {
    console.error('[football-data]', err.message);
    // 200-zal tér vissza hogy a frontend ne álljon le, az AI tipp ettől még lefut
    return jsonRes({
      error:    err.message,
      noData:   true,
      homeTeam: { name: homeTeam, form: '', stats: null, agg: null },
      awayTeam: { name: awayTeam, form: '', stats: null, agg: null },
      lastMatches: { home: [], away: [] },
      h2h: [], nextFixture: null, injuries: [],
    });
  }
}
