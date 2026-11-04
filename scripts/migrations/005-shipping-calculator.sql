-- GYA CMS migration 005: shipping calculator (client spec v1.0, 3 Nov 2026).
-- Run after 004 (SQL Editor > New query > paste > Run). Safe to run again. Additive only:
-- new tables and new nullable order columns. No existing table, column or row is changed.

-- ---------- versioned shipping settings ---------------------------------------------------
-- Every save in the dashboard adds a new row; the highest version is the one in use. Rows are
-- never edited or deleted, so each order can always be traced to the exact settings it used.
create table if not exists public.shipping_config_versions (
  id          bigserial primary key,
  version     integer not null unique,
  config      jsonb not null,
  note        text,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
create or replace function public.shipping_config_versions_readonly() returns trigger
language plpgsql as $$ begin raise exception 'shipping_config_versions_are_read_only'; end $$;
drop trigger if exists shipping_config_versions_readonly on public.shipping_config_versions;
create trigger shipping_config_versions_readonly before update or delete on public.shipping_config_versions
  for each row execute function public.shipping_config_versions_readonly();

-- ---------- the shipping calculation saved with each order --------------------------------
alter table public.orders add column if not exists shipping_quote jsonb;              -- full working (immutable once set)
alter table public.orders add column if not exists shipping_config_version integer;   -- settings version used
alter table public.orders add column if not exists shipping_postcode text;
alter table public.orders add column if not exists shipping_zone text;
alter table public.orders add column if not exists shipping_ex_gst_cents integer;     -- calculated delivery, ex GST
alter table public.orders add column if not exists shipping_override_ex_gst_cents integer;   -- latest manual override, if any

create or replace function public.orders_shipping_immutable() returns trigger
language plpgsql as $$
begin
  if old.shipping_quote is not null and new.shipping_quote is distinct from old.shipping_quote then
    raise exception 'shipping_quote_is_immutable';
  end if;
  if old.shipping_config_version is not null and new.shipping_config_version is distinct from old.shipping_config_version then
    raise exception 'shipping_quote_is_immutable';
  end if;
  if old.shipping_ex_gst_cents is not null and new.shipping_ex_gst_cents is distinct from old.shipping_ex_gst_cents then
    raise exception 'shipping_quote_is_immutable';
  end if;
  return new;
end $$;
drop trigger if exists orders_shipping_immutable on public.orders;
create trigger orders_shipping_immutable before update on public.orders
  for each row execute function public.orders_shipping_immutable();

-- ---------- manual overrides (audit trail; the original calculation is kept) --------------
create table if not exists public.shipping_overrides (
  id                     bigserial primary key,
  order_id               uuid not null references public.orders(id) on delete cascade,
  original_ex_gst_cents  integer,
  new_ex_gst_cents       integer not null check (new_ex_gst_cents >= 0),
  reason                 text not null,
  actor                  text not null,
  created_at             timestamptz not null default now()
);
create index if not exists shipping_overrides_order_idx on public.shipping_overrides (order_id, created_at);

-- ---------- actual courier cost and later adjustments (for profitability) ------------------
create table if not exists public.courier_costs (
  id          bigserial primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  kind        text not null check (kind in ('cost', 'adjustment')),
  amount_cents integer not null,           -- ex GST; adjustments may be negative
  carrier     text,
  note        text,
  actor       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists courier_costs_order_idx on public.courier_costs (order_id, created_at);

-- ---------- access: admins read; only the server writes ------------------------------------
do $$ declare t text; begin
  foreach t in array array['shipping_config_versions', 'shipping_overrides', 'courier_costs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format('create policy "admin read" on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
  end loop;
end $$;

select 'Migration 005 done: shipping calculator tables ready' as result;
