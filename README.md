# backend — соцслой cryptocenter.finance

Fastify + Postgres (СВОЯ база медиа-центра, не база Центра). Первый общий слой
для кошелёк-эксплорера: публичные метки адресов + личный вотчлист + задел под
подписки. Финансовых данных не храним — только пользовательские метки/связи.

## Запуск
```bash
npm install
export DATABASE_URL="postgres://…"   # managed Postgres на личном DO (в secrets.env)
npm run migrate    # создаёт таблицы (идемпотентно)
npm start          # Fastify на :8080
```

## Эндпоинты (v1)
- `GET  /health`
- `GET  /api/labels/:address` — публичные метки адреса (shared)
- `POST /api/labels/:address` — предложить метку {label, note?, authorId?}
- `GET  /api/watchlist/:owner` — личный вотчлист
- `POST /api/watchlist/:owner` — добавить {address, label?}
- `DELETE /api/watchlist/:owner/:address`

## Дальше
- вход-подписью кошелька → редактирование СВОЕГО профиля адреса;
- подписки на профили (соцграф), лента;
- модерация меток (is_hidden), голосование (votes).

Секреты только в env / ~/.synergys/secrets.env. Деплой — отдельный DO App
Platform service на личном (gmail) аккаунте, env DATABASE_URL.
