-- Eyelets option on corflute (standard and custom sizes), version 2026.11.26.
-- Run once in the Supabase SQL Editor of the "Avanti Print" project. Safe to run again: it only adds things,
-- changes no existing value or price, and the site works the same whether or not it has run.
-- Nothing shows on the site until EYELETS_ENABLED=true is set in Vercel.
--
-- What it adds:
--   eyelet_choices          the choices in the Eyelets dropdown, edited in Dashboard > Commerce > Eyelets
--   products.eyelets        tick box: show the Eyelets dropdown on this product
--   order_items.eyelets_*   the choice, the number of eyelets and the amount charged, kept on each order line
--
-- To undo (only if you are sure: it deletes the eyelets list and the eyelets details kept on order lines;
-- the choice text stays in each order's options, so old orders still show it):
--   drop table if exists public.eyelet_choices;
--   alter table public.products drop column if exists eyelets;
--   alter table public.order_items drop column if exists eyelets_label, drop column if exists eyelets_count,
--     drop column if exists eyelets_cents;

-- Give up (and change nothing) rather than wait if a busy table can't be locked straight away.
set lock_timeout = '10s';

-- ---------- the choices ----------
-- price_rule: 'none' no extra charge; 'per_sign' amount added to each sign; 'per_eyelet' amount for each eyelet.
-- count_mode (for per_eyelet): 'fixed' fixed_count eyelets on every sign; 'around' one in each corner and no more
-- than spacing_mm apart around all four edges; 'top' along the top edge, corners included, no more than
-- spacing_mm apart. The count is always worked out on the server from the sign's size. Amounts include GST.
create table if not exists public.eyelet_choices (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (length(btrim(label)) between 1 and 80),
  price_rule  text not null default 'none' check (price_rule in ('none', 'per_sign', 'per_eyelet')),
  amount      numeric(10,2) not null default 0 check (amount >= 0 and amount <= 1000),
  count_mode  text not null default 'fixed' check (count_mode in ('fixed', 'around', 'top')),
  fixed_count int check (fixed_count between 1 and 200),
  spacing_mm  int check (spacing_mm between 50 and 5000),
  position    int not null default 0,
  active      boolean not null default true,
  is_default  boolean not null default false,
  updated_at  timestamptz not null default now(),
  constraint eyelet_choices_count_ok check (price_rule <> 'per_eyelet'
    or (count_mode = 'fixed' and fixed_count is not null)
    or (count_mode in ('around', 'top') and spacing_mm is not null)),
  constraint eyelet_choices_default_active check (not is_default or active)
);
create unique index if not exists eyelet_choices_label_key on public.eyelet_choices (lower(btrim(label)));
create unique index if not exists eyelet_choices_one_default on public.eyelet_choices ((true)) where is_default;

-- The three choices custom size corflute already offers (no extra charge), so customers keep exactly what
-- they can choose today. "No eyelets" is the default. Added only if missing; prices are set later in the dashboard.
insert into public.eyelet_choices (label, price_rule, amount, position, is_default)
select v.label, 'none', 0, v.position, v.is_default
from (values ('No eyelets', 0, true), ('Eyelets - corners', 1, false), ('Eyelets - centre-top', 2, false)) as v(label, position, is_default)
where not exists (select 1 from public.eyelet_choices e where lower(btrim(e.label)) = lower(v.label))
  and (not v.is_default or not exists (select 1 from public.eyelet_choices e where e.is_default));

-- ---------- which products show the dropdown ----------
alter table public.products add column if not exists eyelets boolean not null default false;
-- Standard and custom size corflute. The column is new, so no existing value changes; with EYELETS_ENABLED
-- off the tick has no effect. Only on the first run (while no product has it ticked), so ticks changed later in
-- the dashboard are kept.
update public.products set eyelets = true
where slug in ('corflute-signs', 'corflute-signs-custom-dimensions') and eyelets = false
  and not exists (select 1 from public.products where eyelets);

-- ---------- what was chosen and charged, on each order line ----------
alter table public.order_items add column if not exists eyelets_label text;
alter table public.order_items add column if not exists eyelets_count int;
alter table public.order_items add column if not exists eyelets_cents int;   -- whole line, all signs, GST included

-- ---------- access ----------
-- Read and changed by admins in the dashboard; checkout reads it with the server key. Nothing public.
alter table public.eyelet_choices enable row level security;
revoke all on public.eyelet_choices from anon;
grant select, insert, update, delete on public.eyelet_choices to authenticated;
drop policy if exists "eyelets admin all" on public.eyelet_choices;
create policy "eyelets admin all" on public.eyelet_choices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

select 'Eyelets ready: ' || (select count(*) from public.eyelet_choices) || ' choice(s), shown on '
  || (select count(*) from public.products where eyelets) || ' product(s)' as result;
