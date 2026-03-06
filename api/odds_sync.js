// api/odds-sync.js – TippmixPro scraper adatok fogadása és tárolása KV-ban
// A Python scraper POST-ol ide, a frontend GET-tel olvassa
// ─────────────────────────────────────────────────────────────────────────────
export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Scraper-Key',
};

const KV_KEY        = 'tippmix:live_odds';
const SCRAPER_SECRET = process.env.SCRAPER_SECRET || 'tippmix-secret-2024';

const jsonRes = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

// ─── KV ──────────────────────────────────────────────────────────────────────

function kvBase() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env változók hiányoznak');
  return { url, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

async function kvGet(key) {
  try {
    const { url, headers } = kvBase();
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const v = d.result ?? null;
    if (v == null) return null;
    if (typeof v === 'object') return JSON.stringify(v.value ?? v);
    return String(v);
  } catch { return null; }
}

async function kvSet(key, value, exSeconds = 3600) {
  const { url, headers } = kvBase();
  // EX = lejárat másodpercben (1 óra alapból, odds nem marad örökre)
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST', headers,
    body: JSON.stringify([['SET', key, value, 'EX', exSeconds]]),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`KV SET hiba: ${res.status}`);
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // GET – frontend lekéri az aktuális odds-ot
  if (req.method === 'GET') {
    try {
      const raw = await kvGet(KV_KEY);
      if (!raw) {
        return jsonRes({ hasData: false, data: null, message: 'Nincs aktív odds adat' });
      }
      const parsed = JSON.parse(raw);
      return jsonRes({ hasData: true, ...parsed });
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  }

  // POST – scraper tol ide adatot
  if (req.method === 'POST') {
    // Opcionális auth: SCRAPER_SECRET header
    const authHeader = req.headers.get('X-Scraper-Key');
    if (authHeader && authHeader !== SCRAPER_SECRET) {
      return jsonRes({ error: 'Unauthorized' }, 401);
    }

    let body;
    try { body = await req.json(); }
    catch { return jsonRes({ error: 'Érvénytelen JSON' }, 400); }

    if (!body?.data && !body?.timestamp) {
      return jsonRes({ error: 'Hiányzó "data" vagy "timestamp" mező' }, 400);
    }

    try {
      const payload = JSON.stringify({
        timestamp:   body.timestamp || new Date().toISOString(),
        data:        body.data || [],
        savedAt:     new Date().toISOString(),
        marketCount: (body.data || []).length,
      });

      await kvSet(KV_KEY, payload, 7200); // 2 óra lejárat

      return jsonRes({
        success:     true,
        marketCount: (body.data || []).length,
        savedAt:     new Date().toISOString(),
      });
    } catch (err) {
      return jsonRes({ error: err.message }, 500);
    }
  }

  return jsonRes({ error: 'Method not allowed' }, 405);
}
