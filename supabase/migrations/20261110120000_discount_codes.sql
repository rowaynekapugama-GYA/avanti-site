-- Avanti: discount codes (10 November 2026).
-- Run once in the "Avanti Print" Supabase project: SQL Editor > New query > paste this whole file > Run.
-- Safe to run more than once. Additive only: two new tables and new columns on orders (empty or zero for
-- existing orders).
-- Nothing existing is changed or removed, and the live site keeps working the same until
-- DISCOUNTS_ENABLED=true is set in Vercel.

-- ---------- the codes ---------------------------------------------------------------------------
create table if not exists public.discount_codes (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null check (code ~ '^[A-Z0-9]{2,32}$'),     -- stored in capitals, letters and digits only
  description         text,                                                 -- for staff only, never shown to customers
  applies_to          text not null check (applies_to in ('shipping', 'products')),
  product_scope       text not null default 'all' check (product_scope in ('all', 'selected')),
  product_slugs       text[] not null default '{}',                         -- the products a "selected products" code covers
  kind                text not null check (kind in ('percent', 'amount')),
  percent             numeric(5,2) check (percent is null or (percent > 0 and percent <= 100)),
  amount_cents        integer check (amount_cents is null or amount_cents > 0),
  min_subtotal_cents  integer check (min_subtotal_cents is null or min_subtotal_cents >= 0),
  starts_at           timestamptz,                                          -- from the start of this day, Sydney time
  ends_at             timestamptz,                                          -- to the end of this day, Sydney time
  usage_limit         integer check (usage_limit is null or usage_limit > 0),
  per_email_limit     integer check (per_email_limit is null or per_email_limit > 0),
  active              boolean not null default true,
  uses                integer not null default 0,                           -- paid orders that used the code
  created_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((kind = 'percent' and percent is not null) or (kind = 'amount' and amount_cents is not null))
);
create unique index if not exists discount_codes_code_key on public.discount_codes (upper(btrim(code)));

create or replace function public.discount_codes_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists discount_codes_touch on public.discount_codes;
create trigger discount_codes_touch before update on public.discount_codes for each row execute function public.discount_codes_touch();

-- ---------- each paid order that used a code ----------------------------------------------------
create table if not exists public.discount_redemptions (
  id                       bigserial primary key,
  code_id                  uuid not null references public.discount_codes(id) on delete restrict,   -- a used code can't be deleted
  order_id                 uuid not null unique references public.orders(id) on delete cascade,
  email                    text not null,
  product_discount_cents   integer not null default 0,
  shipping_discount_cents  integer not null default 0,
  created_at               timestamptz not null default now()
);
create index if not exists discount_redemptions_code_idx on public.discount_redemptions (code_id, created_at);
create index if not exists discount_redemptions_email_idx on public.discount_redemptions (code_id, email);

-- ---------- what each order records -------------------------------------------------------------
alter table public.orders add column if not exists discount_code text;
alter table public.orders add column if not exists discount_code_id uuid references public.discount_codes(id) on delete set null;
alter table public.orders add column if not exists discount_type text;                -- percent or amount
alter table public.orders add column if not exists discount_applies_to text;          -- shipping or products
alter table public.orders add column if not exists discount_value numeric(10,2);      -- the percentage, or the dollar amount
alter table public.orders add column if not exists product_discount_cents integer not null default 0;
alter table public.orders add column if not exists shipping_discount_cents integer not null default 0;

-- ---------- count a use once the payment has gone through ---------------------------------------
-- Called by the server when an order becomes paid. Safe to call twice: the second call does nothing.
create or replace function public.discount_redeem(p_order uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare o record; n integer;
begin
  select id, email, discount_code_id, product_discount_cents, shipping_discount_cents into o from public.orders where id = p_order;
  if o.id is null or o.discount_code_id is null then return false; end if;
  insert into public.discount_redemptions (code_id, order_id, email, product_discount_cents, shipping_discount_cents)
    values (o.discount_code_id, o.id, lower(o.email), coalesce(o.product_discount_cents, 0), coalesce(o.shipping_discount_cents, 0))
    on conflict (order_id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then update public.discount_codes set uses = uses + 1 where id = o.discount_code_id; end if;
  return n > 0;
end $$;
revoke all on function public.discount_redeem(uuid) from public, anon, authenticated;
grant execute on function public.discount_redeem(uuid) to service_role;

-- ---------- access: no public access at all; admins read and write; the server does the rest -----
alter table public.discount_codes enable row level security;
alter table public.discount_redemptions enable row level security;
drop policy if exists "admin all" on public.discount_codes;
create policy "admin all" on public.discount_codes for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin read" on public.discount_redemptions;
create policy "admin read" on public.discount_redemptions for select to authenticated using (public.is_admin());
revoke all on public.discount_codes, public.discount_redemptions from anon;
revoke insert, update, delete on public.discount_redemptions from authenticated;
grant all on public.discount_codes, public.discount_redemptions to service_role;
grant usage, select on sequence public.discount_redemptions_id_seq to service_role;

select 'Discount codes ready: ' || (select count(*) from public.discount_codes) || ' code(s) so far' as result;
