-- GYA CMS migration 003: marketing consent, segments, campaigns, automations
-- Run after 002-orders.sql. Safe to run again.

-- every subscribe / unsubscribe, with how and where consent was given (Spam Act record keeping)
create table if not exists public.consent_log (
  id          bigserial primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  action      text not null check (action in ('subscribe','unsubscribe','suppress','resubscribe')),
  basis       text,
  source      text,
  ip          text,
  user_agent  text,
  actor       text not null default 'customer',
  created_at  timestamptz not null default now()
);
create index if not exists consent_log_customer_idx on public.consent_log (customer_id, created_at);

-- saved audiences. rules: {"match":"all"|"any","rules":[{"field":..,"op":..,"value":..}]}
create table if not exists public.segments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  rules       jsonb not null default '{"match":"all","rules":[]}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  subject       text not null default '',
  preview_text  text,
  blocks        jsonb not null default '[]'::jsonb,   -- [{type:'heading'|'text'|'image'|'button'|'products'|'divider', ...}]
  segment_id    uuid references public.segments(id) on delete set null,   -- null = all subscribers
  series        text,
  status        text not null default 'draft' check (status in ('draft','scheduled','sending','sent','cancelled','failed')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  recipients    integer,
  duplicated_from uuid,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists campaigns_status_idx on public.campaigns (status, scheduled_at);

-- the four automated flows; each can be switched on/off with its own delay and email
create table if not exists public.automation_flows (
  key          text primary key check (key in ('welcome','abandoned_cart','post_purchase','win_back')),
  name         text not null,
  description  text,
  enabled      boolean not null default false,
  delay_hours  integer not null check (delay_hours >= 0),
  subject      text not null,
  preview_text text,
  blocks       jsonb not null default '[]'::jsonb,
  categories   text[],                     -- post_purchase: which product categories trigger it
  updated_at   timestamptz not null default now()
);
insert into public.automation_flows (key, name, description, delay_hours, subject, preview_text, blocks, categories) values
 ('welcome', 'Welcome', 'Sent once to every new subscriber.', 0,
  'Welcome to Avanti Print & Design', 'Thanks for subscribing',
  '[{"type":"heading","text":"Thanks for subscribing"},{"type":"text","html":"<p>You''ll be first to hear about new products, seasonal offers and print tips from our Western Sydney factory.</p>"},{"type":"button","label":"Shop now","url":"/#/shop"}]', null),
 ('abandoned_cart', 'Abandoned checkout', 'Checkout started but no order paid after the delay.', 24,
  'Still thinking it over?', 'Your order is saved',
  '[{"type":"heading","text":"Your order is still waiting"},{"type":"text","html":"<p>You started an order with us but didn''t finish checking out. It only takes a minute to pick up where you left off.</p>"},{"type":"cart"},{"type":"button","label":"Finish my order","url":"{{resume_url}}"}]', null),
 ('post_purchase', 'Reorder reminder', 'Sent after a packaging order, when stock is likely running low.', 1440,
  'Running low on boxes?', 'Reorder in a couple of clicks',
  '[{"type":"heading","text":"Time to restock?"},{"type":"text","html":"<p>It''s been a couple of months since your last packaging order. Reorder the same boxes, or tell us what''s changed.</p>"},{"type":"button","label":"Reorder","url":"/#/shop/mailer-boxes"}]', array['mailer-boxes','shipping-cartons']),
 ('win_back', 'Win-back', 'Customers with no order in the delay period.', 4320,
  'We''ve missed you', 'Here''s what''s new at Avanti',
  '[{"type":"heading","text":"It''s been a while"},{"type":"text","html":"<p>A lot has changed since your last order. Take a look at what''s new.</p>"},{"type":"button","label":"See what''s new","url":"/#/shop"}]', null)
on conflict (key) do nothing;

-- one row per flow email sent, so nobody receives the same automated email twice
create table if not exists public.automation_sends (
  id         bigserial primary key,
  flow_key   text not null references public.automation_flows(key) on delete cascade,
  email      text not null,
  ref        text not null,           -- 'signup', an order id, or 'winback:<last order date>'
  email_id   uuid,
  sent_at    timestamptz not null default now(),
  unique (flow_key, email, ref)
);

-- per-customer order history, for segments and the customer list (respects RLS of the caller)
create or replace view public.customer_stats with (security_invoker = true) as
  select c.id as customer_id, c.email,
    count(distinct o.id) filter (where o.status in ('paid','in_production','dispatched','delivered')) as paid_orders,
    coalesce((select sum(o2.total_cents) from public.orders o2 where o2.email = c.email and o2.status in ('paid','in_production','dispatched','delivered')), 0) as total_spent_cents,
    max(o.paid_at) as last_order_at,
    coalesce(array_agg(distinct i.category_slug) filter (where i.category_slug is not null and o.status in ('paid','in_production','dispatched','delivered')), '{}') as categories
  from public.customers c
  left join public.orders o on o.email = c.email
  left join public.order_items i on i.order_id = o.id
  group by c.id, c.email;

do $$ declare t text; begin
  foreach t in array array['consent_log','automation_sends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format('create policy "admin read" on public.%I for select to authenticated using (public.is_admin())', t);
    execute format('revoke insert, update, delete on public.%I from authenticated, anon', t);
  end loop;
  -- drafts, segments and flow settings are edited directly from the dashboard by admins;
  -- sending, scheduling and consent always go through the server
  foreach t in array array['segments','campaigns','automation_flows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin all" on public.%I', t);
    execute format('create policy "admin all" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;
grant select on public.customer_stats to authenticated;
