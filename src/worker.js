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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  // public + max-age → браузер і Cloudflare edge кешують відповідь. Інвалідація —
  // cache.delete() у refreshAll (кнопка _refresh / cron) скидає edge негайно.
  'Cache-Control': `public, max-age=${EDGE_TTL}`,
};

// Для POST-відповідей (dealer_signup) кеш не потрібен — той самий CORS, але no-store.
const CORS_NO_CACHE = { ...CORS_HEADERS, 'Cache-Control': 'no-store' };

function json(body, status = 200) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(txt, { status, headers: CORS_HEADERS });
}

function jsonNoCache(body, status = 200) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(txt, { status, headers: CORS_NO_CACHE });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =============================================================================
// Заявки дилерів (react.ink/verify) → Telegram
// Статика не може тримати bot-токен (репо публічне). Токен бота тут теж НЕ
// тримаємо — відправку делегуємо в react-bot через service binding env.BOT
// (у нього токен @stepan_react_bot уже є). Захист виклику — спільний SYNC_SECRET.
// Worker Secrets на react-pricelist:
//   wrangler secret put SYNC_SECRET             (той самий, що у react-bot)
//   wrangler secret put DEALER_NOTIFY_CHAT_IDS  (через кому: "111,222")
// =============================================================================
async function notifyViaBot(env, chatIds, text) {
  try {
    const r = await env.BOT.fetch(new Request('https://react-bot.internal/?action=_notify_dealer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': env.SYNC_SECRET || '' },
      body: JSON.stringify({ chat_ids: chatIds, text }),
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      console.log('notifyViaBot fail', r.status, JSON.stringify(j).slice(0, 200));
      return 0;
    }
    return j.sent || 0;
  } catch (e) {
    console.log('notifyViaBot threw', String(e));
    return 0;
  }
}

// Best-effort: зберегти заявку в D1 (dealer_accounts, status=pending) через price-api.
// Саме завдяки цьому публічна заявка зʼявляється у списку «Заявки на розгляді» в
// адмінці (dealers.html) — без цього вона осідала лише в Telegram+Planfix.
async function saveSignupToDb(env, fields) {
  try {
    const r = await env.UPSTREAM.fetch(new Request('https://price-api.internal/?action=_admin_dealer_signup_save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': env.SYNC_SECRET || '' },
      body: JSON.stringify(fields),
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) console.log('signup_save fail', r.status, JSON.stringify(j).slice(0, 200));
    else console.log('signup_save ok', j.token, j.updated ? 'updated' : 'pending');
  } catch (e) {
    console.log('signup_save threw', String(e));
  }
}

// Best-effort: створити контакт у Planfix (шаблон «Дилер») через price-api (UPSTREAM).
// Не блокує заявку — якщо Planfix недоступний/скоуп токена закритий, лише лог.
async function createPlanfixContact(env, fields) {
  try {
    const r = await env.UPSTREAM.fetch(new Request('https://price-api.internal/?action=_admin_dealer_planfix_create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': env.SYNC_SECRET || '' },
      body: JSON.stringify(fields),
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) console.log('planfix contact fail', r.status, JSON.stringify(j).slice(0, 200));
    else console.log('planfix contact ok', j.id);
  } catch (e) {
    console.log('planfix contact threw', String(e));
  }
}

// Глобальна стеля заявок на добу — backstop проти KV write-флуду (IP легко
// ротувати через IPv6 /64 чи ботнет; per-IP ліміт сам по собі не рятує). KV
// writes на цьому акаунті обмежені free-tier'ом (~1000/добу на всі воркери).
const SIGNUP_DAILY_CAP = 100;

async function handleDealerSignup(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonNoCache({ error: 'bad_json' }, 400);
  }
  // Тіло мусить бути JSON-обʼєктом (не null / число / масив), інакше доступ
  // до полів нижче кине TypeError → header-less 500.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonNoCache({ error: 'bad_json' }, 400);
  }

  // Honeypot: приховане поле company_url людина не бачить, бот — заповнює.
  // Вдаємо успіх, нічого не шлемо.
  if (body.company_url && String(body.company_url).trim()) {
    return jsonNoCache({ ok: true });
  }

  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const f = {
    org_type: clip(body.org_type, 40),
    company:  clip(body.company, 200),
    code:     clip(body.code, 40),
    contact:  clip(body.contact, 120),
    phone:    clip(body.phone, 40),
    email:    clip(body.email, 120),
    city:     clip(body.city, 80),
    settlement: clip(body.settlement, 120),
    field:    clip(body.field, 80),
    volume:   clip(body.volume, 80),
    site:     clip(body.site, 200),
    comment:  clip(body.comment, 1000),
    ref:      clip(body.ref, 40),
  };

  // contact+phone обовʼязкові; company може бути порожня (Фізособа — без назви компанії).
  if (!f.contact || !f.phone) {
    return jsonNoCache({ error: 'missing_required' }, 422);
  }

  // --- Анти-флуд (writes інкрементимо лише коли запит прийнято → bounded) ---
  // 1) Глобальна добова стеля — захист від ротації IP.
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const dayKey = `signup_day_${day}`;
  const dayCnt = parseInt((await env.KV.get(dayKey)) || '0', 10);
  if (dayCnt >= SIGNUP_DAILY_CAP) return jsonNoCache({ error: 'rate_limited' }, 429);

  // 2) Per-IP: не більше 5 заявок на годину.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rlKey = `rl_signup_${ip}`;
  const ipCnt = parseInt((await env.KV.get(rlKey)) || '0', 10);
  if (ipCnt >= 5) return jsonNoCache({ error: 'rate_limited' }, 429);

  ctx.waitUntil(env.KV.put(dayKey, String(dayCnt + 1), { expirationTtl: 2 * 24 * 3600 }));
  ctx.waitUntil(env.KV.put(rlKey, String(ipCnt + 1), { expirationTtl: 3600 }));

  // Planfix-контакт (шаблон «Дилер») — best-effort, паралельно з телеграмом.
  if (env.UPSTREAM && env.SYNC_SECRET) ctx.waitUntil(createPlanfixContact(env, f));

  // D1: pending-заявка → зʼявиться у списку апруву в адмінці. Незалежно від
  // того, чи налаштована телеграм-доставка нижче (лід не губимо).
  if (env.UPSTREAM && env.SYNC_SECRET) ctx.waitUntil(saveSignupToDb(env, f));

  const chats = (env.DEALER_NOTIFY_CHAT_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!env.BOT || !env.SYNC_SECRET || !chats.length) {
    // Свідомо «голосний» провал: оператор має виставити секрети/біндинг одразу
    // після деплою. Лід не губимо — лишаємо у логах воркера.
    console.log('dealer_signup lead (доставка не налаштована):', JSON.stringify(f));
    return jsonNoCache({ error: 'not_configured' }, 503);
  }

  const lines = [
    '🟢 <b>Нова заявка дилера</b> · react.ink',
    f.ref     ? `<b>Номер заявки:</b> ${escapeHtml(f.ref)}` : '',
    '',
    f.company ? `<b>Компанія:</b> ${escapeHtml(f.company)}${f.org_type ? ` (${escapeHtml(f.org_type)})` : ''}`
              : (f.org_type ? `<b>Тип:</b> ${escapeHtml(f.org_type)}` : ''),
    f.code    ? `<b>Код ЄДРПОУ/ІПН:</b> ${escapeHtml(f.code)}` : '',
    `<b>Контакт:</b> ${escapeHtml(f.contact)}`,
    `<b>Телефон:</b> ${escapeHtml(f.phone)}`,
    f.email   ? `<b>Email:</b> ${escapeHtml(f.email)}` : '',
    f.city    ? `<b>Область:</b> ${escapeHtml(f.city)}` : '',
    f.settlement ? `<b>Населений пункт:</b> ${escapeHtml(f.settlement)}` : '',
    f.field   ? `<b>Сфера:</b> ${escapeHtml(f.field)}` : '',
    f.volume  ? `<b>Обсяг/міс:</b> ${escapeHtml(f.volume)}` : '',
    f.site    ? `<b>Сайт:</b> ${escapeHtml(f.site)}` : '',
    f.comment ? `\n<b>Коментар:</b>\n${escapeHtml(f.comment)}` : '',
  ].filter(l => l !== '');
  const text = lines.join('\n');

  const sent = await notifyViaBot(env, chats, text);

  if (!sent) {
    // Доставка впала — рятуємо лід у KV (рідкісний шлях, тож зайвий write ок).
    console.log('dealer_signup delivery failed, archiving:', JSON.stringify(f));
    ctx.waitUntil(env.KV.put(`signup_fail_${Date.now()}_${ip}`, JSON.stringify(f), {
      expirationTtl: 30 * 24 * 3600,
    }));
    return jsonNoCache({ error: 'delivery_failed' }, 502);
  }
  return jsonNoCache({ ok: true, sent });
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

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    // POST: лише форма заявки дилера.
    if (request.method === 'POST') {
      if (action === 'dealer_signup') {
        return await handleDealerSignup(request, env, ctx);
      }
      return jsonNoCache({ error: 'unknown action' }, 400);
    }

    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }

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

    // Допомога знайти chat_id для DEALER_NOTIFY_CHAT_IDS: одержувач пише боту,
    // далі смикаємо getUpdates і дивимось id чатів. Admin-only через ?secret=.
    if (action === '_dealer_updates') {
      const secret = url.searchParams.get('secret');
      if (!env.REFRESH_SECRET || secret !== env.REFRESH_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
      if (!env.TELEGRAM_BOT_TOKEN) return json({ error: 'no_token' }, 503);
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`);
        const data = await r.json();
        const chats = {};
        for (const u of (data.result || [])) {
          const m = u.message || u.edited_message || u.my_chat_member || u.channel_post;
          const c = m && m.chat;
          if (c) {
            chats[c.id] = {
              id: c.id,
              type: c.type,
              name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || '',
              username: c.username || '',
            };
          }
        }
        return json({ ok: true, chats: Object.values(chats) });
      } catch (e) {
        return json({ error: String(e) }, 502);
      }
    }

    if (action === '_health') {
      const ptKey = priceListKey(PT_NO_VAT, PT_WITH_VAT);
      const [pl, fx] = await Promise.all([
        env.KV.get(ptKey),
        env.KV.get('fx_nbu'),
      ]);
      const chats = (env.DEALER_NOTIFY_CHAT_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      return json({
        ok: true,
        cache: {
          price_list_get: pl ? `${pl.length} bytes` : 'empty',
          fx_nbu: fx ? `${fx.length} bytes` : 'empty',
        },
        dealer_signup: {
          has_bot_binding: !!env.BOT,
          has_sync_secret: !!env.SYNC_SECRET,
          notify_count: chats.length,
        },
      });
    }

    return json({ error: 'unknown action' }, 400);
  },
};
