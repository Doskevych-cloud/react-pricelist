// react-pricelist · публічний прайс react.ink
// =============================================================================
// Тонкий cache-проксі над основним worker (price-api). Жодного зв'язку з 1С,
// D1, OData — лише KV-кеш JSON-відповідей upstream.
//
// Endpoints:
//   GET /?action=price_list_get&pt_no=...&pt_with=...
//   GET /?action=fx_swift
//
// Cron щогодини оновлює обидва ключі. Якщо upstream падає, віддаємо stale-кеш.
// =============================================================================

// UPSTREAM (price-api) дістаємо через service binding env.UPSTREAM —
// in-process call, без HTTP edge. URL у запиті не має значення — CF
// маршрутизує до прив'язаного worker'а напряму.
const UPSTREAM_HOST = 'https://price-api.internal';

// Hardcoded price-types для публічного прайсу (Гуртова без ПДВ / з ПДВ).
// Якщо знадобиться інша комбінація — додати ключ у PREFETCH_KEYS.
const PT_NO_VAT   = '36084004-bfb6-11f0-86f2-107c6149f3d7';
const PT_WITH_VAT = '6a417c18-3eec-11f1-870a-107c6149f3d7';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
};

function json(body, status = 200) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(txt, { status, headers: CORS_HEADERS });
}

function priceListKey(ptNo, ptWith) {
  return `price_list_get_${ptNo || 'auto'}_${ptWith || 'auto'}`;
}

async function fetchUpstream(env, path) {
  try {
    const r = await env.UPSTREAM.fetch(new Request(UPSTREAM_HOST + path, {
      headers: { 'User-Agent': 'react-pricelist' },
    }));
    const text = await r.text();
    if (!r.ok) {
      console.log('upstream not ok', r.status, path, text.slice(0, 200));
      return null;
    }
    // Sanity: переконаємось що це валідний JSON, інакше не пишемо в кеш.
    try { JSON.parse(text); } catch (e) {
      console.log('upstream invalid JSON', path, text.slice(0, 200));
      return null;
    }
    return text;
  } catch (e) {
    console.log('upstream fetch threw', String(e));
    return null;
  }
}

async function getOrFetch(env, kvKey, upstreamPath) {
  // 1) Cache hit → відразу.
  const cached = await env.KV.get(kvKey);
  if (cached) return json(cached);

  // 2) Cache miss → live fetch.
  const fresh = await fetchUpstream(env, upstreamPath);
  if (fresh) {
    // 7d TTL — cron оновлює щогодини, але якщо cron падає, маємо stale-fallback.
    await env.KV.put(kvKey, fresh, { expirationTtl: 7 * 24 * 3600 });
    return json(fresh);
  }

  // 3) Upstream down + кешу немає.
  return json({ error: 'upstream unavailable, no cache' }, 503);
}

async function refreshAll(env) {
  const tasks = [
    {
      kvKey: priceListKey(PT_NO_VAT, PT_WITH_VAT),
      path: `/?action=price_list_get&pt_no=${encodeURIComponent(PT_NO_VAT)}&pt_with=${encodeURIComponent(PT_WITH_VAT)}`,
    },
    {
      kvKey: 'fx_swift',
      path: '/?action=fx_swift',
    },
  ];

  const results = [];
  for (const t of tasks) {
    const fresh = await fetchUpstream(env, t.path);
    if (fresh) {
      await env.KV.put(t.kvKey, fresh, { expirationTtl: 7 * 24 * 3600 });
      results.push({ key: t.kvKey, ok: true, size: fresh.length });
    } else {
      results.push({ key: t.kvKey, ok: false });
    }
  }
  return results;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAll(env));
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'price_list_get') {
      const ptNo = url.searchParams.get('pt_no');
      const ptWith = url.searchParams.get('pt_with');
      const path = `/?action=price_list_get&pt_no=${encodeURIComponent(ptNo || '')}&pt_with=${encodeURIComponent(ptWith || '')}`;
      return await getOrFetch(env, priceListKey(ptNo, ptWith), path);
    }

    if (action === 'fx_swift') {
      return await getOrFetch(env, 'fx_swift', '/?action=fx_swift');
    }

    // Manual refresh — admin-only через ?secret=. Корисно після правок прайсу
    // в 1С: одразу прогріти кеш, не чекаючи cron.
    if (action === '_refresh') {
      const secret = url.searchParams.get('secret');
      if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
      const results = await refreshAll(env);
      return json({ ok: true, results });
    }

    if (action === '_health') {
      const ptKey = priceListKey(PT_NO_VAT, PT_WITH_VAT);
      const [pl, fx] = await Promise.all([
        env.KV.get(ptKey),
        env.KV.get('fx_swift'),
      ]);
      return json({
        ok: true,
        cache: {
          price_list_get: pl ? `${pl.length} bytes` : 'empty',
          fx_swift: fx ? `${fx.length} bytes` : 'empty',
        },
      });
    }

    return json({ error: 'unknown action' }, 400);
  },
};
