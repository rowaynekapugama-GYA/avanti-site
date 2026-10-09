-- GYA CMS migration 002: customers, orders, payments, webhooks, audit, email log
-- Run after supabase-schema.sql (SQL Editor > New query > paste > Run). Safe to run again.
--
-- Money is stored in cents (integers) so totals never drift through rounding.
-- Order status only ever changes through public.order_transition(), which enforces the
-- allowed moves and writes the timeline. Only the server (service role) can call it:
-- the browser can read orders as an admin but never write them directly.

create extension if not exists pgcrypto;

-- ---------- customers ------------------------------------------------------
create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique check (email = lower(email)),
  name            text,
  phone           text,
  state           text,                      -- NSW, VIC, ...
  postcode        text,
  tags            text[] not null default '{}',
  -- marketing consent (Spam Act): a customer is only ever emailed a campaign when
  -- marketing_status = 'subscribed' AND consent_basis AND consent_at are recorded
  marketing_status text not null default 'not_subscribed'
                   check (marketing_status in ('subscribed','unsubscribed','not_subscribed')),
  consent_basis   text check (consent_basis in ('checkout_opt_in','footer_signup','imported_list','admin_added')),
  consent_at      timestamptz,
  consent_source  text,                      -- e.g. order number, page, or the imported list's provenance
  consent_ip      text,
  unsubscribed_at timestamptz,
  suppressed      boolean not null default false,   -- hard bounce or spam complaint: never email marketing
  suppressed_reason text,
  pref_token      uuid not null default gen_random_uuid() unique,  -- unsubscribe / preference links
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists customers_status_idx on public.customers (marketing_status);

-- ---------- orders ---------------------------------------------------------
create sequence if not exists public.order_number_seq start 1001;
create table if not exists public.orders (
  id              uuid primary key default gen_random_uuid(),
  number          text not null unique default ('AVP-' || nextval('public.order_number_seq')),
  public_token    uuid not null default gen_random_uuid(),   -- lets the customer view their own order page
  status          text not null default 'pending_payment'
                  check (status in ('pending_payment','paid','in_production','dispatched','delivered','cancelled','refunded')),
  email           text not null check (email = lower(email)),
  customer_id     uuid references public.customers(id) on delete set null,
  name            text,
  phone           text,
  company         text,
  shipping_address jsonb not null default '{}'::jsonb,       -- {line1,line2,suburb,state,postcode,country}
  delivery_method text,
  delivery_cents  integer not null default 0,
  delivery_quote_required boolean not null default false,    -- some items have no delivery rate yet
  subtotal_cents  integer not null,
  total_cents     integer not null,
  gst_cents       integer not null default 0,                -- GST included in total (prices are GST-inclusive)
  currency        text not null default 'AUD',
  provider        text check (provider in ('stripe','paypal','simulator')),
  provider_session_id text,                                  -- Stripe Checkout Session / PayPal order id
  provider_ref    text,                                      -- Stripe PaymentIntent / PayPal capture id
  provider_status text,
  marketing_opt_in boolean not null default false,
  campaign_id     uuid,                                      -- email campaign that brought the customer (attribution)
  customer_note   text,
  carrier         text,
  tracking_number text,
  tracking_url    text,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  in_production_at timestamptz,
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  refunded_at     timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_email_idx on public.orders (email);
create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists orders_session_idx on public.orders (provider_session_id);

create table if not exists public.order_items (
  id            bigserial primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  position      integer not null default 0,
  product_slug  text not null,
  name          text not null,
  category_slug text,
  options       jsonb not null default '{}'::jsonb,      -- size, material, personalisation text...
  qty           integer not null check (qty > 0),
  unit_cents    integer not null,
  line_cents    integer not null,
  artwork       jsonb                                     -- {files:[{side,name,path}], later, design}
);
create index if not exists order_items_order_idx on public.order_items (order_id);

-- timeline of every status change, and who made it
create table if not exists public.order_events (
  id          bigserial primary key,
  order_id    uuid not null references public.orders(id) on delete cascade,
  from_status text,
  to_status   text,
  actor       text not null,            -- 'customer', 'webhook:stripe', 'admin:jo@avantiprint.com.au', 'system'
  note        text,
  data        jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists order_events_order_idx on public.order_events (order_id, created_at);

-- every webhook received, so repeats are ignored and failures can be retried/inspected
create table if not exists public.webhook_events (
  id           bigserial primary key,
  provider     text not null,
  event_id     text not null,
  type         text,
  status       text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error        text,
  payload      jsonb,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_id)
);

-- admin actions outside the order timeline (campaign sends, imports, settings)
create table if not exists public.audit_log (
  id          bigserial primary key,
  actor       text not null,
  action      text not null,
  target_type text,
  target_id   text,
  data        jsonb,
  created_at  timestamptz not null default now()
);

-- every email sent: transactional, marketing, automation, test
create table if not exists public.email_log (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('transactional','campaign','automation','test')),
  template      text,
  to_email      text not null,
  subject       text,
  order_id      uuid references public.orders(id) on delete set null,
  campaign_id   uuid,
  automation_key text,
  customer_id   uuid references public.customers(id) on delete set null,
  provider      text not null default 'resend',      -- 'resend', or 'log' when sending is switched off
  provider_id   text,                                -- Resend email id
  status        text not null default 'queued'
                check (status in ('queued','sent','delivered','delivery_delayed','bounced','complained','failed','logged')),
  bounce_reason text,
  error         text,
  opened_at     timestamptz,
  clicked_at    timestamptz,
  delivered_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists email_log_provider_idx on public.email_log (provider_id);
create index if not exists email_log_campaign_idx on public.email_log (campaign_id);
create index if not exists email_log_created_idx on public.email_log (created_at desc);

-- ---------- the one way to change an order's status ------------------------
create or replace function public.order_transition(p_order uuid, p_to text, p_actor text,
  p_note text default null, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.orders; allowed text[];
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0002'; end if;
  if o.status = p_to then   -- repeats (a webhook delivered twice) are a harmless no-op
    return jsonb_build_object('changed', false, 'status', o.status);
  end if;
  allowed := case o.status
    when 'pending_payment' then array['paid','cancelled']
    when 'paid'            then array['in_production','cancelled','refunded']
    when 'in_production'   then array['dispatched','cancelled','refunded']
    when 'dispatched'      then array['delivered','refunded']
    when 'delivered'       then array['refunded']
    else array[]::text[] end;
  if not (p_to = any(allowed)) then
    raise exception 'invalid_transition: % -> %', o.status, p_to using errcode = 'P0001';
  end if;
  if p_to = 'dispatched' and (coalesce(p_data->>'carrier','') = '' or coalesce(p_data->>'tracking_number','') = '') then
    raise exception 'carrier_and_tracking_required' using errcode = 'P0001';
  end if;
  update public.orders set
    status = p_to, updated_at = now(),
    paid_at          = case when p_to = 'paid' then now() else paid_at end,
    in_production_at = case when p_to = 'in_production' then now() else in_production_at end,
    dispatched_at    = case when p_to = 'dispatched' then now() else dispatched_at end,
    delivered_at     = case when p_to = 'delivered' then now() else delivered_at end,
    cancelled_at     = case when p_to = 'cancelled' then now() else cancelled_at end,
    refunded_at      = case when p_to = 'refunded' then now() else refunded_at end,
    provider_ref     = coalesce(nullif(p_data->>'provider_ref',''), provider_ref),
    provider_status  = coalesce(nullif(p_data->>'provider_status',''), provider_status),
    carrier          = case when p_to = 'dispatched' then p_data->>'carrier' else carrier end,
    tracking_number  = case when p_to = 'dispatched' then p_data->>'tracking_number' else tracking_number end,
    tracking_url     = case when p_to = 'dispatched' then nullif(p_data->>'tracking_url','') else tracking_url end
  where id = p_order;
  insert into public.order_events (order_id, from_status, to_status, actor, note, data)
    values (p_order, o.status, p_to, p_actor, p_note, p_data);
  return jsonb_build_object('changed', true, 'from', o.status, 'status', p_to);
end $$;
revoke all on function public.order_transition(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.order_transition(uuid, text, text, text, jsonb) to service_role;

-- dashboard numbers in one call (admins only)
create or replace function public.admin_order_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not public.is_admin() then null else jsonb_build_object(
    'revenue_paid_cents', coalesce((select sum(total_cents) from public.orders where status in ('paid','in_production','dispatched','delivered')), 0),
    'orders',             (select count(*) from public.orders where status <> 'pending_payment'),
    'open_orders',        (select count(*) from public.orders where status in ('paid','in_production')),
    'awaiting_payment',   (select count(*) from public.orders where status = 'pending_payment'),
    'customers',          (select count(*) from public.customers),
    'subscribers',        (select count(*) from public.customers where marketing_status = 'subscribed' and not suppressed),
    'active_products',    (select count(*) from public.products where published)
  ) end
$$;
grant execute on function public.admin_order_stats() to authenticated;

-- ---------- access: admins read; only the server writes --------------------
do $$ declare t text; begin
  foreach t in array array['customers','orders','order_items','order_events','webhook_events','audit_log','email_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format('create policy "admin read" on public.%I for select to authenticated using (public.is_admin())', t);
  end loop;
end $$;
-- admins may edit a customer's details and tags from the dashboard. Consent fields are left
-- out of the column grant on purpose: consent only changes through the server, which logs it.
drop policy if exists "admin update" on public.customers;
create policy "admin update" on public.customers for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke update on public.customers from authenticated, anon;
grant update (name, phone, state, postcode, tags, updated_at) on public.customers to authenticated;
revoke insert, update, delete on public.orders, public.order_items, public.order_events, public.webhook_events,
  public.audit_log, public.email_log from authenticated, anon;
