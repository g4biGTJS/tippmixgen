// api/football-data.js – meccs statisztikák API-Football-ból (v3, ingyenes tier)
// Regisztráció: https://dashboard.api-football.com → ingyenes 100 req/nap
// Env: API_FOOTBALL_KEY
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY || '1cd704dff5d7c89e4f961c3d902930f7';

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

// ─── API hívás ────────────────────────────────────────────────────────────────

async function afoot(endpoint, params = {}) {
  const key = API_KEY;

  const url = new URL(`${BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), {
    headers: { 'x-apisports-key': key },
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) throw new Error(`API-Football HTTP ${res.status}`);
  const json = await res.json();

  if (json.errors && Object.keys(json.errors).length) {
    const msg = Object.values(json.errors).join(', ');
    throw new Error(`API-Football: ${msg}`);
  }

  return json.response ?? [];
}

// ─── Csapat keresés név alapján ───────────────────────────────────────────────

async function findTeam(name) {
  // API-Football csak alfanumerikus + szóköz karaktert fogad el
  const cleanName = name.replace(/[^a-zA-Z0-9 áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, ' ').trim();
  const results = await afoot('/teams', { search: cleanName });
  if (!results.length) throw new Error(`Csapat nem található: "${name}"`);

  // Pontos egyezés előnyben
  const exact = results.find(r =>
    r.team.name.toLowerCase() === name.toLowerCase() ||
    r.team.name.toLowerCase().includes(name.toLowerCase())
  );
  const team = (exact || results[0]).team;
  return team;
}

// ─── Utolsó N befejezett meccs ────────────────────────────────────────────────

async function getLastMatches(teamId, last = 10) {
  const res = await afoot('/fixtures', {
    team: teamId, last, status: 'FT',
  });

  return res.map(r => ({
    date:      r.fixture.date?.split('T')[0] ?? '',
    home:      r.teams.home.name,
    away:      r.teams.away.name,
    homeGoals: r.goals.home ?? 0,
    awayGoals: r.goals.away ?? 0,
    winner:    r.teams.home.winner ? 'home' : r.teams.away.winner ? 'away' : 'draw',
    league:    r.league?.name ?? '',
    leagueId:  r.league?.id   ?? null,
    season:    r.league?.season ?? null,
    // Szöglet és büntető ha van
    corners: {
      home: r.statistics?.find(s => s.team.id === r.teams.home.id)
              ?.statistics?.find(s => s.type === 'Corner Kicks')?.value ?? null,
      away: r.statistics?.find(s => s.team.id === r.teams.away.id)
              ?.statistics?.find(s => s.type === 'Corner Kicks')?.value ?? null,
    },
  }));
}

// ─── H2H ─────────────────────────────────────────────────────────────────────

async function getH2H(id1, id2, last = 8) {
  const res = await afoot('/fixtures/headtohead', {
    h2h: `${id1}-${id2}`, last, status: 'FT',
  });

  return res.map(r => ({
    date:      r.fixture.date?.split('T')[0] ?? '',
    home:      r.teams.home.name,
    away:      r.teams.away.name,
    homeGoals: r.goals.home ?? 0,
    awayGoals: r.goals.away ?? 0,
    winner:    r.teams.home.winner ? 'home' : r.teams.away.winner ? 'away' : 'draw',
    league:    r.league?.name ?? '',
  }));
}

// ─── Szezon statisztikák ──────────────────────────────────────────────────────

async function getSeasonStats(teamId, leagueId, season) {
  try {
    const res = await afoot('/teams/statistics', {
      team: teamId, league: leagueId, season,
    });
    if (!res || typeof res !== 'object' || Array.isArray(res)) return null;

    const s = res;
    return {
      played:          s.fixtures?.played?.total         ?? 0,
      wins:            s.fixtures?.wins?.total           ?? 0,
      draws:           s.fixtures?.draws?.total          ?? 0,
      losses:          s.fixtures?.loses?.total          ?? 0,
      goalsFor:        s.goals?.for?.total?.total        ?? 0,
      goalsAgainst:    s.goals?.against?.total?.total    ?? 0,
      avgGoalsFor:     s.goals?.for?.average?.total      ?? '0',
      avgGoalsAgainst: s.goals?.against?.average?.total  ?? '0',
      cleanSheets:     s.clean_sheet?.total              ?? 0,
      failedToScore:   s.failed_to_score?.total          ?? 0,
      form:            s.form                            ?? '',
      biggestWin:      s.biggest?.wins?.home             ?? '',
      biggestLoss:     s.biggest?.loses?.away            ?? '',
      // Szöglet átlag ha van
      avgCornersFor:   s.cards ? null : null, // API-Football nem adja direkt
    };
  } catch {
    return null;
  }
}

// ─── Sérülések / eltiltások ───────────────────────────────────────────────────

async function getInjuries(fixtureId) {
  try {
    const res = await afoot('/injuries', { fixture: fixtureId });
    return res.map(r => ({
      team:   r.team.name,
      player: r.player.name,
      type:   r.player.type,
      reason: r.player.reason,
    }));
  } catch {
    return [];
  }
}

// ─── Következő meccs keresés ──────────────────────────────────────────────────

async function getNextFixture(id1, id2) {
  try {
    const res = await afoot('/fixtures/headtohead', {
      h2h: `${id1}-${id2}`, next: 1,
    });
    if (!res.length) return null;
    const r = res[0];
    return {
      id:       r.fixture.id,
      date:     r.fixture.date?.split('T')[0] ?? '',
      home:     r.teams.home.name,
      away:     r.teams.away.name,
      league:   r.league?.name ?? '',
      leagueId: r.league?.id   ?? null,
      season:   r.league?.season ?? null,
    };
  } catch {
    return null;
  }
}

// ─── Forma string számítás ────────────────────────────────────────────────────

function calcForm(matches, teamName) {
  return matches.slice(0, 5).map(m => {
    const isHome = m.home === teamName;
    if (m.winner === 'draw') return 'D';
    return (isHome && m.winner === 'home') || (!isHome && m.winner === 'away') ? 'W' : 'L';
  }).join('');
}

// ─── Szöglet és gól statisztika az utolsó meccsekből ─────────────────────────

function aggregateMatchStats(matches, teamName) {
  if (!matches.length) return null;

  let totalGoalsFor = 0, totalGoalsAgainst = 0;
  let over25 = 0, btts = 0, cleanSheets = 0;

  for (const m of matches) {
    const isHome = m.home === teamName;
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    totalGoalsFor     += gf;
    totalGoalsAgainst += ga;
    if (gf + ga > 2.5) over25++;
    if (gf > 0 && ga > 0) btts++;
    if (ga === 0) cleanSheets++;
  }

  const n = matches.length;
  return {
    avgGoalsFor:     +(totalGoalsFor  / n).toFixed(2),
    avgGoalsAgainst: +(totalGoalsAgainst / n).toFixed(2),
    over25Pct:       Math.round(over25 / n * 100),
    bttsPct:         Math.round(btts   / n * 100),
    cleanSheetPct:   Math.round(cleanSheets / n * 100),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return jsonRes({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return jsonRes({ error: 'Érvénytelen JSON body' }, 400); }

  const { homeTeam, awayTeam } = body;
  if (!homeTeam || !awayTeam) {
    return jsonRes({ error: '"homeTeam" és "awayTeam" kötelező.' }, 400);
  }

  try {
    // 1. Csapatok azonosítása
    const [homeData, awayData] = await Promise.all([
      findTeam(homeTeam),
      findTeam(awayTeam),
    ]);

    const homeId = homeData.id;
    const awayId = awayData.id;

    // 2. Párhuzamos alaplekérések
    const [homeMatches, awayMatches, h2h, nextFixture] = await Promise.all([
      getLastMatches(homeId, 10),
      getLastMatches(awayId, 10),
      getH2H(homeId, awayId, 8),
      getNextFixture(homeId, awayId),
    ]);

    // 3. Szezon statisztikák (liga + szezon a legfrissebb meccsből)
    const leagueId = nextFixture?.leagueId
      || homeMatches[0]?.leagueId
      || null;
    const season = nextFixture?.season
      || homeMatches[0]?.season
      || new Date().getFullYear();

    let homeStats = null, awayStats = null, injuries = [];

    if (leagueId) {
      [homeStats, awayStats] = await Promise.all([
        getSeasonStats(homeId, leagueId, season),
        getSeasonStats(awayId, leagueId, season),
      ]);
    }

    if (nextFixture?.id) {
      injuries = await getInjuries(nextFixture.id);
    }

    // 4. Lokális aggregáció
    const homeAgg = aggregateMatchStats(homeMatches, homeData.name);
    const awayAgg = aggregateMatchStats(awayMatches, awayData.name);

    return jsonRes({
      homeTeam: {
        id:     homeId,
        name:   homeData.name,
        logo:   homeData.logo,
        form:   calcForm(homeMatches, homeData.name),
        stats:  homeStats,
        agg:    homeAgg,
      },
      awayTeam: {
        id:     awayId,
        name:   awayData.name,
        logo:   awayData.logo,
        form:   calcForm(awayMatches, awayData.name),
        stats:  awayStats,
        agg:    awayAgg,
      },
      lastMatches: {
        home: homeMatches,
        away: awayMatches,
      },
      h2h,
      nextFixture,
      injuries,
    });

  } catch (err) {
    console.error('[football-data]', err.message);
    return jsonRes({ error: err.message }, 500);
  }
}
