// react-pricelist · публічний прайс react.ink
// =============================================================================
// Тонкий cache-проксі над основним worker (price-api). Жодного зв'язку з 1С,
// D1, OData — лише KV-кеш JSON-відповідей upstream.
//
// Endpoints:
//   GET /?action=price_list_get&pt_no=...&pt_with=...
//   GET /?action=fx_nbu
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

// Edge-кеш TTL. Прайс міняється раз на день (cron з 1С) або по кнопці «Оновити»
// в адмінці; курс НБУ — раз на день зранку. Тому віддаємо з edge-кешу Cloudflare
// (безкоштовний, НЕ рахується в KV-ліміт) і чіпаємо KV лише на edge-miss.
// 5 хв — стеля глобального розсинхрону після кнопки (Cache API per-colo, тож для
// решти регіонів покладаємось на короткий max-age). 99% переглядів → 0 KV reads.
const EDGE_TTL = 300; // 5 хв

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  // public + max-age → браузер і Cloudflare edge кешують відповідь. Інвалідація —
  // cache.delete() у refreshAll (кнопка _refresh / cron) скидає edge негайно.
  'Cache-Control': `public, max-age=${EDGE_TTL}`,
};

function json(body, status = 200) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(txt, { status, headers: CORS_HEADERS });
}

function priceListKey(ptNo, ptWith) {
  return `price_list_get_${ptNo || 'auto'}_${ptWith || 'auto'}`;
}

// Синтетичний стабільний Request-ключ для Cache API (edge-кеш адресується по URL).
function edgeKey(kvKey) {
  return new Request(`https://react-pricelist.cache/${kvKey}`);
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

async function getOrFetch(env, ctx, kvKey, upstreamPath) {
  const cache = caches.default;
  const ck = edgeKey(kvKey);

  // 0) Edge hit → 0 KV reads (основний шлях для публічного трафіку).
  const hit = await cache.match(ck);
  if (hit) {
    const r = new Response(hit.body, hit);
    r.headers.set('X-Cache', 'HIT');
    return r;
  }

  // 1) Edge miss → KV.
  let body = await env.KV.get(kvKey);

  // 2) KV miss → live fetch + засів KV (7d stale-fallback на випадок падіння cron).
  if (!body) {
    const fresh = await fetchUpstream(env, upstreamPath);
    if (!fresh) return json({ error: 'upstream unavailable, no cache' }, 503);
    await env.KV.put(kvKey, fresh, { expirationTtl: 7 * 24 * 3600 });
    body = fresh;
  }

  const res = json(body);
  res.headers.set('X-Cache', 'MISS');
  // Засіяти edge — наступні запити в цьому colo не торкнуться KV до EDGE_TTL.
  ctx.waitUntil(cache.put(ck, res.clone()));
  return res;
}

async function refreshAll(env) {
  const tasks = [
    {
      kvKey: priceListKey(PT_NO_VAT, PT_WITH_VAT),
      path: `/?action=price_list_get&pt_no=${encodeURIComponent(PT_NO_VAT)}&pt_with=${encodeURIComponent(PT_WITH_VAT)}`,
    },
    {
      kvKey: 'fx_nbu',
      path: '/?action=fx_nbu',
    },
  ];

  const cache = caches.default;
  const results = [];
  for (const t of tasks) {
    const fresh = await fetchUpstream(env, t.path);
    if (fresh) {
      await env.KV.put(t.kvKey, fresh, { expirationTtl: 7 * 24 * 3600 });
      // Скинути edge-кеш ключа → нова ціна/курс підхопляться одразу (у цьому colo).
      await cache.delete(edgeKey(t.kvKey));
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

  async fetch(request, env, ctx) {
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
      return await getOrFetch(env, ctx, priceListKey(ptNo, ptWith), path);
    }

    if (action === 'fx_nbu') {
      return await getOrFetch(env, ctx, 'fx_nbu', '/?action=fx_nbu');
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
        env.KV.get('fx_nbu'),
      ]);
      return json({
        ok: true,
        cache: {
          price_list_get: pl ? `${pl.length} bytes` : 'empty',
          fx_nbu: fx ? `${fx.length} bytes` : 'empty',
        },
      });
    }

    return json({ error: 'unknown action' }, 400);
  },
};
