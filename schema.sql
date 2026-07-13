-- Медиа-центр · соцслой кошельков (cryptocenter.finance). Своя база, НЕ база Центра.
-- Первый общий (shared) слой: публичные метки адресов + подписки-вотчлист.
-- Владение адресом (edit своего профиля) — позже через вход-подписью кошелька.

-- Публичные метки адресов (по типу Etherscan public tags): кто угодно предлагает,
-- показываем всем. Модерация — флагом is_hidden (оператор скрывает спам).
create table if not exists address_labels (
  id          bigserial primary key,
  address     text not null,                 -- 0x… нижним регистром
  label       text not null,                 -- короткая метка («Binance Hot», «моя казна»)
  note        text,                          -- необязательное описание
  author_id   text,                          -- анонимный id браузера (позже — юзер)
  votes       integer not null default 0,    -- полезность метки
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_labels_address on address_labels (lower(address));

-- Профиль читателя/юзера (вход по e-mail magic-link — позже). Пока задел.
create table if not exists users (
  id          bigserial primary key,
  email       text unique,
  handle      text unique,
  created_at  timestamptz not null default now()
);

-- Вотчлист: пользователь следит за адресами (свой набор кошельков).
create table if not exists watchlist (
  id          bigserial primary key,
  owner_id    text not null,                 -- id пользователя/браузера
  address     text not null,
  label       text,                          -- личная подпись
  created_at  timestamptz not null default now(),
  unique (owner_id, address)
);
create index if not exists idx_watch_owner on watchlist (owner_id);

-- Подписки на профили адресов (соцграф): кто на какой адрес подписан.
create table if not exists follows (
  id          bigserial primary key,
  follower_id text not null,
  target      text not null,                 -- адрес, за которым следят
  created_at  timestamptz not null default now(),
  unique (follower_id, target)
);
create index if not exists idx_follows_target on follows (lower(target));
