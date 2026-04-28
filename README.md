# react-pricelist

Backend для публічного прайсу `react.ink`.

## Що це

Тонкий cache-проксі над основним worker `price-api.doskevich.workers.dev`. Окремий
сервіс — щоб правки ERP-бекенду не могли зламати публічну сторінку.

- **Frontend**: `react-ink-public` репо → `react.ink`.
- **Backend (цей репо)**: `react-pricelist.doskevich.workers.dev`.
- **Upstream**: `price-api.doskevich.workers.dev` (читається лише раз/годину
  через cron). Якщо upstream падає — повертається stale-кеш з KV (TTL 7d).

Жодного 1С / OData / D1 безпосередньо.

## Endpoints

| URL | Що віддає |
|---|---|
| `/?action=price_list_get&pt_no=...&pt_with=...` | Каталог цін (як у `price-api`) з KV-кешу |
| `/?action=fx_swift` | SWIFT-курси USD/EUR з KV-кешу |
| `/?action=_health` | Розміри обох cache-ключів |
| `/?action=_refresh&secret=$REFRESH_SECRET` | Примусово оновити кеш (admin) |

## Deploy

```bash
cd /Users/dmitriydoskevich/Desktop/код/react-pricelist
npx wrangler deploy
```

## Перший запуск

```bash
# 1. Створити KV
npx wrangler kv:namespace create CACHE
# скопіювати id у wrangler.toml

# 2. Set admin secret для _refresh
npx wrangler secret put REFRESH_SECRET

# 3. Deploy
npx wrangler deploy

# 4. Прогріти кеш одразу (інакше перший запит читач триггерить live fetch)
curl "https://react-pricelist.doskevich.workers.dev/?action=_refresh&secret=$YOUR_SECRET"
```

## Cron

`7 * * * *` — щогодини на 7й хвилині оновлюємо обидва ключі. Зміщення від
основного worker'а (`5 2 * * *`) — щоб не битися за 1С-ресурси.
