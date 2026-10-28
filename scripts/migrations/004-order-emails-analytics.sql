-- GYA CMS migration 004: order analytics, and dispatch without a tracking number.
-- Run after 003 (SQL Editor > New query > paste > Run). Safe to run again.
--
-- Additive only: two new indexes, one new server-only table for switches, one new read-only
-- function for the server, and the existing order_transition function re-created with two small
-- changes (see below). No table, column or row is dropped, renamed or rewritten, and existing
-- orders keep their status and data.

-- ---------- faster date ranges for analytics, faster email look-ups per order ---------------
create index if not exists orders_paid_at_idx on public.orders (paid_at);
create index if not exists email_log_order_idx on public.email_log (order_id);

-- ---------- server-only switches (e.g. the dashboard's order email on/off) ---------------------
-- Row-level security with no policies: only the server (service role) can read or change these.
create table if not exists public.app_flags (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_flags enable row level security;
revoke all on public.app_flags from anon, authenticated;

-- ---------- status changes (same rules as 002, with two changes) ----------------------------
-- 1. A tracking number is optional when marking dispatched (the carrier is still required).
-- 2. A paid order that was cancelled can then be marked refunded, so a refund made in Stripe or
--    PayPal after cancelling updates the order instead of being rejected.
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
    when 'cancelled'       then case when o.paid_at is not null then array['refunded'] else array[]::text[] end
    else array[]::text[] end;
  if not (p_to = any(allowed)) then
    raise exception 'invalid_transition: % -> %', o.status, p_to using errcode = 'P0001';
  end if;
  if p_to = 'dispatched' and coalesce(p_data->>'carrier','') = '' then
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
    tracking_number  = case when p_to = 'dispatched' then nullif(p_data->>'tracking_number','') else tracking_number end,
    tracking_url     = case when p_to = 'dispatched' then nullif(p_data->>'tracking_url','') else tracking_url end
  where id = p_order;
  insert into public.order_events (order_id, from_status, to_status, actor, note, data)
    values (p_order, o.status, p_to, p_actor, p_note, p_data);
  return jsonb_build_object('changed', true, 'from', o.status, 'status', p_to);
end $$;
revoke all on function public.order_transition(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.order_transition(uuid, text, text, text, jsonb) to service_role;

-- ---------- analytics (read-only; called by the server for signed-in admins) ----------------
-- Counts orders that have been paid, dated by when they were paid, in the business timezone so
-- monthly totals line up with Avanti's calendar. Unfinished checkouts never count. With
-- p_exclude_cancelled (the default), cancelled and refunded orders are left out of orders,
-- revenue, average order value, items and top products; "orders by status" always shows them.
-- Also returns the same figures for the previous period of equal length, for % change.
create or replace function public.admin_order_analytics(p_from date, p_to date,
  p_tz text default 'Australia/Sydney', p_exclude_cancelled boolean default true)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days   int := (p_to - p_from) + 1;
  v_grain  text := case when (p_to - p_from) + 1 <= 62 then 'day' else 'month' end;
  v_start  timestamptz := p_from::timestamp at time zone p_tz;
  v_end    timestamptz := (p_to + 1)::timestamp at time zone p_tz;
  v_pstart timestamptz := (p_from - ((p_to - p_from) + 1))::timestamp at time zone p_tz;
  v_out    jsonb;
begin
  if p_to < p_from then raise exception 'bad_range' using errcode = 'P0001'; end if;
  with base as (
    select o.id, o.email, o.status, o.total_cents, o.paid_at, (o.paid_at at time zone p_tz)::date as d,
           (o.paid_at >= v_start) as cur, o.status in ('cancelled', 'refunded') as voided
    from public.orders o
    where o.paid_at is not null and o.paid_at >= v_pstart and o.paid_at < v_end
  ),
  counted as (select * from base where not (p_exclude_cancelled and voided)),
  firsts as (
    select email, min(paid_at) as first_paid from public.orders
    where paid_at is not null and email in (select email from base) group by email
  ),
  item_tot as (
    select oi.order_id, sum(oi.qty)::int as qty from public.order_items oi
    where oi.order_id in (select id from counted) group by oi.order_id
  ),
  k as (
    select c.cur,
           count(*)::int as orders,
           coalesce(sum(c.total_cents), 0)::bigint as revenue_cents,
           coalesce(sum(it.qty), 0)::int as items,
           count(distinct c.email) filter (where f.first_paid >= case when c.cur then v_start else v_pstart end)::int as new_customers,
           count(distinct c.email) filter (where f.first_paid <  case when c.cur then v_start else v_pstart end)::int as returning_customers
    from counted c left join item_tot it on it.order_id = c.id left join firsts f on f.email = c.email
    group by c.cur
  ),
  kpi as (
    select p.cur, coalesce(k.orders, 0) as orders, coalesce(k.revenue_cents, 0) as revenue_cents, coalesce(k.items, 0) as items,
           coalesce(k.new_customers, 0) as new_customers, coalesce(k.returning_customers, 0) as returning_customers
    from (values (true), (false)) p(cur) left join k on k.cur = p.cur
  ),
  buckets as (
    select g::date as bucket from generate_series(
      case when v_grain = 'day' then p_from else date_trunc('month', p_from)::date end, p_to,
      case when v_grain = 'day' then interval '1 day' else interval '1 month' end) g
  ),
  series as (
    select b.bucket, count(c.id)::int as orders, coalesce(sum(c.total_cents), 0)::bigint as revenue_cents
    from buckets b left join counted c on c.cur and
      (case when v_grain = 'day' then c.d else date_trunc('month', c.d)::date end) = b.bucket
    group by b.bucket
  ),
  months as (
    select g::date as month from generate_series(date_trunc('month', p_from)::date, p_to, interval '1 month') g
  ),
  monthly as (
    select m.month, count(c.id)::int as orders, coalesce(sum(c.total_cents), 0)::bigint as revenue_cents,
           coalesce(sum(it.qty), 0)::int as items
    from months m left join counted c on c.cur and date_trunc('month', c.d)::date = m.month
    left join item_tot it on it.order_id = c.id
    group by m.month
  ),
  by_status as (
    select status, count(*)::int as orders from base where cur group by status
  ),
  top as (
    select oi.product_slug as slug, max(oi.name) as name, sum(oi.qty)::int as qty, sum(oi.line_cents)::bigint as revenue_cents
    from public.order_items oi join counted c on c.id = oi.order_id and c.cur
    group by oi.product_slug order by sum(oi.qty) desc, sum(oi.line_cents) desc limit 10
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'tz', p_tz, 'grain', v_grain, 'exclude_cancelled', p_exclude_cancelled,
    'previous_from', p_from - v_days, 'previous_to', p_from - 1,
    'current',  (select jsonb_build_object('orders', orders, 'revenue_cents', revenue_cents, 'items', items,
                  'aov_cents', case when orders > 0 then round(revenue_cents::numeric / orders) else 0 end,
                  'new_customers', new_customers, 'returning_customers', returning_customers) from kpi where cur),
    'previous', (select jsonb_build_object('orders', orders, 'revenue_cents', revenue_cents, 'items', items,
                  'aov_cents', case when orders > 0 then round(revenue_cents::numeric / orders) else 0 end,
                  'new_customers', new_customers, 'returning_customers', returning_customers) from kpi where not cur),
    'series', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'orders', orders, 'revenue_cents', revenue_cents) order by bucket) from series), '[]'::jsonb),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'orders', orders, 'revenue_cents', revenue_cents, 'items', items,
                  'aov_cents', case when orders > 0 then round(revenue_cents::numeric / orders) else 0 end) order by month) from monthly), '[]'::jsonb),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', status, 'orders', orders) order by orders desc) from by_status), '[]'::jsonb),
    'top_products', coalesce((select jsonb_agg(jsonb_build_object('slug', slug, 'name', name, 'qty', qty, 'revenue_cents', revenue_cents) order by qty desc, revenue_cents desc) from top), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke all on function public.admin_order_analytics(date, date, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_order_analytics(date, date, text, boolean) to service_role;

select 'Migration 004 done: analytics ready, tracking number optional on dispatch' as result;
