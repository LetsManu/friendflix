import pg from 'pg';

export type Db = Pick<pg.Pool, 'query'>;

export const MIGRATIONS: string[] = [
  // 1: core
  `
  create table users (
    id uuid primary key,
    authentik_sub text unique not null,
    email text,
    name text not null,
    role text not null,
    jellyfin_user_id text not null,
    jellyfin_username text not null,
    jellyfin_pw_enc text not null,
    seerr_user_id integer,
    disabled boolean not null default false,
    created_at timestamptz not null default now()
  );
  create table audit_log (
    id bigserial primary key,
    at timestamptz not null default now(),
    actor uuid,
    action text not null,
    target text,
    meta jsonb not null default '{}'
  );
  create table watchlist (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    added_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  `,
  // 2: invites + devices
  `
  create table invites (
    id uuid primary key,
    token_hash text unique not null,
    role text not null,
    note text,
    expires_at timestamptz not null,
    used_at timestamptz,
    used_by uuid references users(id) on delete set null,
    created_by uuid references users(id) on delete set null,
    authentik_invite text,
    created_at timestamptz not null default now()
  );
  create table devices (
    user_id uuid not null references users(id) on delete cascade,
    device_id text not null,
    label text not null,
    approved boolean not null default false,
    created_at timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    primary key (user_id, device_id)
  );
  `,
  // 3: seerr request mapping + notifications
  `
  create table seerr_requests (
    id bigserial primary key,
    seerr_request_id integer unique not null,
    user_id uuid not null references users(id) on delete cascade,
    media_type text not null,
    tmdb_id integer not null,
    title text not null,
    poster text,
    created_at timestamptz not null default now()
  );
  create table notifications (
    id bigserial primary key,
    user_id uuid references users(id) on delete cascade,
    kind text not null,
    title text not null,
    body text,
    link text,
    dedupe text unique,
    created_at timestamptz not null default now(),
    read_at timestamptz
  );
  create index notifications_user on notifications(user_id, created_at desc);
  `,
  // 4: polls, ratings, series follows
  `
  create table polls (
    id uuid primary key,
    title text not null,
    created_by uuid not null references users(id) on delete cascade,
    closes_at timestamptz not null,
    starts_at timestamptz not null,
    status text not null default 'open',
    winner_option_id bigint,
    room_id text,
    seerr_request_id integer,
    created_at timestamptz not null default now()
  );
  create table poll_options (
    id bigserial primary key,
    poll_id uuid not null references polls(id) on delete cascade,
    jf_item_id text,
    tmdb_id integer,
    media_type text,
    title text not null,
    poster text
  );
  create table poll_votes (
    poll_id uuid not null references polls(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    option_id bigint not null references poll_options(id) on delete cascade,
    primary key (poll_id, user_id)
  );
  create table ratings (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    item_name text not null,
    stars smallint not null check (stars between 1 and 5),
    review text,
    created_at timestamptz not null default now(),
    primary key (user_id, item_id)
  );
  create table series_follows (
    user_id uuid not null references users(id) on delete cascade,
    series_id text not null,
    series_name text not null,
    primary key (user_id, series_id)
  );
  `,
  // 5: watch statistics + achievements
  `
  create table play_seconds (
    user_id uuid not null references users(id) on delete cascade,
    item_id text not null,
    day date not null,
    seconds integer not null default 0,
    item_name text not null,
    item_type text,
    series_name text,
    primary key (user_id, item_id, day)
  );
  create table achievements (
    user_id uuid not null references users(id) on delete cascade,
    key text not null,
    earned_at timestamptz not null default now(),
    primary key (user_id, key)
  );
  `,
  // 6: viewing preferences
  `
  create table user_prefs (
    user_id uuid primary key references users(id) on delete cascade,
    data jsonb not null default '{}',
    updated_at timestamptz not null default now()
  );
  `,
];

export async function migrate(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727274)');
    await c.query('create table if not exists schema_migrations (version int primary key, at timestamptz not null default now())');
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const done = await c.query('select 1 from schema_migrations where version = $1', [i + 1]);
      if (done.rowCount) continue;
      await c.query('begin');
      try {
        await c.query(MIGRATIONS[i]!);
        await c.query('insert into schema_migrations(version) values ($1)', [i + 1]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    c.release();
  }
}
