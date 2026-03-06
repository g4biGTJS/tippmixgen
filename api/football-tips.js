// api/football-tips.js – AI tipp generátor · llm7.io
// Tipp típusok: 1X2, Over/Under gól, BTTS, Szöglet, Büntető + AI által javasolt
// Input: homeTeam, awayTeam, matchData (football-data.js), scraperData (TippmixPro JSON)
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const LLM = {
  url:       'https://api.llm7.io/v1/chat/completions',
  model:     'llama-3.3-70b-instruct-fp8-fast',
  timeout:   40_000,
  maxTokens: 4000,
};

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── LLM hívás ───────────────────────────────────────────────────────────────

async function llmCall(system, user, temp = 0.55, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(LLM.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer unused' },
        body: JSON.stringify({
          model:       LLM.model,
          temperature: temp,
          max_tokens:  LLM.maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: user   },
          ],
        }),
        signal: AbortSignal.timeout(LLM.timeout),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => String(res.status));
        throw new Error(`HTTP ${res.status}: ${err.slice(0, 120)}`);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Üres LLM válasz');
      return text;

    } catch (err) {
      if (i === retries) throw err;
      await sleep(900 * (i + 1));
    }
  }
}

// ─── JSON kibontás ────────────────────────────────────────────────────────────

function extractJSON(text) {
  const clean = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Nem található JSON objektum a válaszban');
  return JSON.parse(m[0]);
}

// ─── TippmixPro odds feldolgozás ──────────────────────────────────────────────
// Scraper output: { timestamp, data: [{market_id, market_part, legend, outcomes:[{text,odds}]}] }

function processOdds(scraperData) {
  if (!scraperData?.data?.length) return null;

  const result = {
    matchResult: null,   // 1X2
    overUnder:   [],     // Over/Under gól
    btts:        null,   // Mindkét csapat szerez
    corners:     [],     // Szöglet piacok
    cards:       [],     // Lap piacok
    firstGoal:   null,   // Első gól
    halftime:    null,   // Félidő eredmény
    other:       [],     // Egyéb
  };

  for (const market of scraperData.data) {
    const legend   = (market.legend || '').toLowerCase().trim();
    const outcomes = market.outcomes || [];

    // Segéd: outcome objektumok normalizálva
    const oc = outcomes.map(o => ({
      label: (o.text || '').trim(),
      odds:  parseFloat(o.odds) || null,
    }));

    // ── 1X2 ──
    if (
      /^(1x2|meccs eredmény|match result|mérkőzés eredménye|végeredmény)/.test(legend) ||
      (oc.length === 3 &&
        oc.some(o => o.label === '1') &&
        oc.some(o => ['x', 'x (döntetlen)', 'döntetlen'].includes(o.label.toLowerCase())) &&
        oc.some(o => o.label === '2'))
    ) {
      const o1 = oc.find(o => o.label === '1');
      const oX = oc.find(o => ['x', 'x (döntetlen)', 'döntetlen'].includes(o.label.toLowerCase()));
      const o2 = oc.find(o => o.label === '2');
      if (o1 && oX && o2) {
        result.matchResult = {
          home: o1.odds, draw: oX.odds, away: o2.odds,
          homeProb: probFromOdds(o1.odds),
          drawProb: probFromOdds(oX.odds),
          awayProb: probFromOdds(o2.odds),
        };
      }
      continue;
    }

    // ── Over/Under gól ──
    if (/gól|goal|over|under|több|kevesebb/.test(legend) &&
        !/szöglet|corner|lap|card/.test(legend)) {
      result.overUnder.push({ market: market.legend, outcomes: oc });
      continue;
    }

    // ── BTTS ──
    if (/mindkét|both team|btts|gg|ng|gól-gól/.test(legend)) {
      const yes = oc.find(o => /igen|yes|gg|i$/.test(o.label.toLowerCase()));
      const no  = oc.find(o => /nem|no|ng|n$/.test(o.label.toLowerCase()));
      result.btts = {
        yes: yes?.odds ?? null, yesProb: probFromOdds(yes?.odds),
        no:  no?.odds  ?? null, noProb:  probFromOdds(no?.odds),
      };
      continue;
    }

    // ── Szöglet ──
    if (/szöglet|corner/.test(legend)) {
      result.corners.push({ market: market.legend, outcomes: oc });
      continue;
    }

    // ── Lapok ──
    if (/lap|card|sárga|piros/.test(legend)) {
      result.cards.push({ market: market.legend, outcomes: oc });
      continue;
    }

    // ── Félidő ──
    if (/félidő|half.?time|ht/.test(legend)) {
      result.halftime = { market: market.legend, outcomes: oc };
      continue;
    }

    // ── Első gól ──
    if (/első gól|first goal|anytime/.test(legend)) {
      result.firstGoal = { market: market.legend, outcomes: oc };
      continue;
    }

    // ── Egyéb ──
    result.other.push({ market: market.legend, outcomes: oc });
  }

  return result;
}

function probFromOdds(odds) {
  if (!odds || odds <= 1) return null;
  return Math.round(100 / odds);
}

// ─── Forma szöveg ─────────────────────────────────────────────────────────────

function formatMatches(matches, teamName, n = 6) {
  if (!matches?.length) return 'Nincs adat';
  return matches.slice(0, n).map(m => {
    const isHome = m.home === teamName;
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    const res = m.winner === 'draw' ? 'D' :
      (isHome && m.winner === 'home') || (!isHome && m.winner === 'away') ? 'W' : 'L';
    const opp = isHome ? m.away : m.home;
    return `${res} ${gf}-${ga} vs ${opp} (${isHome ? 'H' : 'I'}) [${m.league}]`;
  }).join('\n  ');
}

function formatH2H(h2h, homeName, awayName) {
  if (!h2h?.length) return 'Nincs H2H adat';
  let hw = 0, aw = 0, d = 0;
  const lines = h2h.slice(0, 6).map(m => {
    const score = `${m.homeGoals}-${m.awayGoals}`;
    let who;
    if (m.winner === 'draw')                       { d++;  who = 'Döntetlen'; }
    else if (m.home === homeName && m.winner === 'home') { hw++; who = `${homeName} nyert`; }
    else if (m.home === awayName && m.winner === 'home') { aw++; who = `${awayName} nyert`; }
    else if (m.winner === 'home')                  { hw++; who = `${m.home} nyert`; }
    else                                           { aw++; who = `${m.away} nyert`; }
    return `  ${m.date}  ${m.home} ${score} ${m.away}  → ${who}  [${m.league}]`;
  });
  return `${homeName} ${hw}W / ${d}D / ${aw}W az utolsó ${h2h.length} meccsből\n` + lines.join('\n');
}

function formatStats(stats, agg) {
  if (!stats && !agg) return 'Nincs szezon statisztika';
  const parts = [];
  if (stats) {
    const gd = (stats.goalsFor || 0) - (stats.goalsAgainst || 0);
    parts.push(`${stats.played}m: ${stats.wins}W-${stats.draws}D-${stats.losses}L`);
    parts.push(`Gólok: ${stats.goalsFor}:${stats.goalsAgainst} (GD:${gd >= 0 ? '+' : ''}${gd})`);
    parts.push(`Átlag: ${stats.avgGoalsFor} GF / ${stats.avgGoalsAgainst} GA`);
    parts.push(`Forma: ${stats.form || 'n/a'} | CS: ${stats.cleanSheets} | G.nélkül: ${stats.failedToScore}`);
  }
  if (agg) {
    parts.push(`Utolsó meccsekből: avg GF ${agg.avgGoalsFor} GA ${agg.avgGoalsAgainst} | Over2.5: ${agg.over25Pct}% | BTTS: ${agg.bttsPct}% | CS: ${agg.cleanSheetPct}%`);
  }
  return parts.join('\n  ');
}

function formatOdds(odds) {
  if (!odds) return 'Nincs TippmixPro odds';
  const lines = [];

  if (odds.matchResult) {
    const mr = odds.matchResult;
    lines.push(`1X2: 1=${mr.home}(${mr.homeProb}%)  X=${mr.draw}(${mr.drawProb}%)  2=${mr.away}(${mr.awayProb}%)`);
  }

  if (odds.overUnder.length) {
    lines.push('Over/Under:');
    odds.overUnder.slice(0, 5).forEach(m => {
      lines.push(`  ${m.market}: ${m.outcomes.map(o => `${o.label} @${o.odds}`).join(' | ')}`);
    });
  }

  if (odds.btts) {
    lines.push(`BTTS: Igen @${odds.btts.yes}(${odds.btts.yesProb}%)  Nem @${odds.btts.no}(${odds.btts.noProb}%)`);
  }

  if (odds.corners.length) {
    lines.push('Szöglet piacok:');
    odds.corners.slice(0, 4).forEach(m => {
      lines.push(`  ${m.market}: ${m.outcomes.map(o => `${o.label} @${o.odds}`).join(' | ')}`);
    });
  }

  if (odds.cards.length) {
    lines.push('Lap piacok:');
    odds.cards.slice(0, 3).forEach(m => {
      lines.push(`  ${m.market}: ${m.outcomes.map(o => `${o.label} @${o.odds}`).join(' | ')}`);
    });
  }

  if (odds.halftime) {
    lines.push(`Félidő: ${odds.halftime.outcomes.map(o => `${o.label} @${o.odds}`).join(' | ')}`);
  }

  if (odds.other.length) {
    lines.push('Egyéb:');
    odds.other.slice(0, 4).forEach(m => {
      lines.push(`  ${m.market}: ${m.outcomes.map(o => `${o.label} @${o.odds}`).join(' | ')}`);
    });
  }

  return lines.join('\n');
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(homeTeam, awayTeam, matchData, odds) {
  const hName = homeTeam;
  const aName = awayTeam;
  const hd    = matchData?.homeTeam;
  const ad    = matchData?.awayTeam;
  const inj   = matchData?.injuries || [];
  const fix   = matchData?.nextFixture;

  const system = `Te egy profi futball fogadási elemző vagy, aki mély statisztikai tudással rendelkezik.
Minden tippet az adatokkal támasztasz alá: forma, H2H, szezon stat, odds value elemzés.
Kizárólag valid JSON-t adsz vissza. Semmi markdown, semmi magyarázat a JSON-on kívül.`;

  const injLines = inj.length
    ? inj.map(i => `  ${i.team} – ${i.player} (${i.type}: ${i.reason})`).join('\n')
    : '  Nincs ismert sérült/eltiltott';

  const user = `
# MÉRKŐZÉS
${hName}  vs  ${aName}
${fix ? `Dátum: ${fix.date}  |  Liga: ${fix.league}` : 'Következő meccs dátuma ismeretlen'}

════════════════════════════════════════
# TIPPMIXPRO ODDS
════════════════════════════════════════
${formatOdds(odds)}

════════════════════════════════════════
# ${hName} – FORMA & STATISZTIKÁK
════════════════════════════════════════
Forma: ${hd?.form || 'n/a'}
Szezon:
  ${formatStats(hd?.stats, hd?.agg)}
Utolsó meccsek:
  ${formatMatches(matchData?.lastMatches?.home, hName)}

════════════════════════════════════════
# ${aName} – FORMA & STATISZTIKÁK
════════════════════════════════════════
Forma: ${ad?.form || 'n/a'}
Szezon:
  ${formatStats(ad?.stats, ad?.agg)}
Utolsó meccsek:
  ${formatMatches(matchData?.lastMatches?.away, aName)}

════════════════════════════════════════
# H2H (egymás elleni)
════════════════════════════════════════
${formatH2H(matchData?.h2h, hName, aName)}

════════════════════════════════════════
# SÉRÜLTEK / ELTILTOTTAK
════════════════════════════════════════
${injLines}

════════════════════════════════════════
# FELADAT
════════════════════════════════════════
Elemezd a meccset alaposan minden adat alapján.
Adj value-alapú tippeket – ahol az odds magasabb a valódi valószínűségnél.

Válasz KIZÁRÓLAG az alábbi JSON struktúrában:

{
  "matchResult": {
    "prediction": "1" | "X" | "2" | "1X" | "X2" | "12",
    "confidence": 1-100,
    "odds": null vagy szám,
    "reasoning": "2-3 mondat adatokkal alátámasztva"
  },
  "overUnder": {
    "line": 2.5,
    "prediction": "over" | "under",
    "confidence": 1-100,
    "odds": null vagy szám,
    "reasoning": "1-2 mondat"
  },
  "btts": {
    "prediction": true | false,
    "confidence": 1-100,
    "odds": null vagy szám,
    "reasoning": "1-2 mondat"
  },
  "corners": {
    "line": szám (KÖTELEZŐ – ha nincs odds, becsüld: Premier League átlag ~10, kisebb ligák ~9),
    "prediction": "over" | "under" (KÖTELEZŐ – mindig adj becslést a csapatok stílusa alapján),
    "confidence": 1-100,
    "odds": null vagy szám,
    "reasoning": "1-2 mondat – támadó csapatok több szögletet szereznek, becsüld a liga és stílus alapján"
  },
  "cards": {
    "line": szám (KÖTELEZŐ – ha nincs odds, becsüld: átlag ~3-4 lap/meccs),
    "prediction": "over" | "under" (KÖTELEZŐ – rangadók, rivalizálás = több lap),
    "confidence": 1-100,
    "odds": null vagy szám,
    "reasoning": "1-2 mondat – meccs tétje, rivalizálás, bíró szigora alapján becsüld"
  },
  "bestBet": {
    "market": "melyik piac (pl. Over 2.5 gól)",
    "pick": "pontosan mit ajánlasz",
    "odds": null vagy szám,
    "confidence": 1-100,
    "valuePct": null vagy szám (mennyivel jobb az odds a valódinál, %),
    "reasoning": "2-3 mondat: miért ez a legjobb value, milyen adatok támasztják alá"
  },
  "keyFactors": [
    "1. tényező",
    "2. tényező",
    "3. tényező",
    "4. tényező (opcionális)",
    "5. tényező (opcionális)"
  ],
  "riskLevel": "low" | "medium" | "high",
  "analysis": "5-7 mondatos átfogó elemzés magyarul, konkrét számokkal és tényekkel",
  "extraTips": [
    {
      "market": "piac neve",
      "pick": "mit ajánlasz",
      "odds": null vagy szám,
      "confidence": 1-100,
      "reasoning": "1-2 mondat"
    }
  ]
}

FONTOS:
- Az extraTips-ben adj 2-4 extra tippet amit az AI hasznosnak tart (félidő, első gól, stb.)
- NINCS Hendikep / Ázsiai Hendikep tipp
- Minden confidence érték reális legyen (ne legyen minden 90+)
- Szöglet és lap tippnél MINDIG adj konkrét line-t és predikciót – "nincs elég adat" NEM elfogadható válasz
- Ha nincs szöglet/lap odds: becsüld a csapatok stílusa és liga átlag alapján (szöglet: 9-11, lapok: 3-5)
- Confidence szöglet/lapnál lehet 45-65 ha csak becslés, de prediction és line MINDIG legyen kitöltve
`.trim();

  return { system, user };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST')    return jsonRes({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); }
  catch { return jsonRes({ error: 'Érvénytelen JSON body' }, 400); }

  // ── Input ──
  // homeTeam:    string  – hazai csapat neve
  // awayTeam:    string  – vendég csapat neve
  // matchData:   object  – football-data.js válasza (opcionális)
  // scraperData: object  – TippmixPro scraper JSON outputja (opcionális)

  const { homeTeam, awayTeam, matchData = null, scraperData = null } = body;

  if (!homeTeam || !awayTeam) {
    return jsonRes({ error: '"homeTeam" és "awayTeam" kötelező.' }, 400);
  }

  const odds = scraperData ? processOdds(scraperData) : null;
  const { system, user } = buildPrompt(homeTeam, awayTeam, matchData, odds);

  try {
    const text   = await llmCall(system, user, 0.55);
    const tips   = extractJSON(text);

    return jsonRes({
      homeTeam,
      awayTeam,
      tips,
      meta: {
        oddsUsed:    !!odds,
        statsUsed:   !!matchData,
        generatedAt: new Date().toISOString(),
        model:       LLM.model,
      },
    });

  } catch (err) {
    console.error('[football-tips]', err.message);
    return jsonRes({ error: err.message }, 500);
  }
}
