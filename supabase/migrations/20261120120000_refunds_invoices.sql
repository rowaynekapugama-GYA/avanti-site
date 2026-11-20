-- Refunds from the dashboard, tax invoices and adjustment notes (20 November 2026).
--
-- Safe to run more than once. Additive only: new tables, new empty columns on orders, new functions and a
-- new private storage bucket. No existing value is changed. Until REFUNDS_ENABLED / INVOICES_ENABLED are
-- set to true in Vercel the site behaves exactly as before, whether or not this has been run.

-- Give up (and change nothing) rather than wait if a busy table can't be locked straight away.
set lock_timeout = '10s';

-- ---------- business details printed on tax invoices (admin only, one row) ----------
create table if not exists public.business_details (
  id            integer primary key default 1 check (id = 1),
  legal_name    text,
  trading_name  text,
  abn           text,
  address       text,
  phone         text,
  email         text,
  invoice_footer text,
  logo_path     text,          -- in the private "invoices" bucket
  updated_at    timestamptz not null default now(),
  updated_by    text
);

-- ---------- numbering: one counter row per series, locked while a number is taken ----------
-- A Postgres sequence can skip numbers when a transaction rolls back. A locked counter row can't:
-- the number is taken and written to the order in the same transaction, so there are no gaps or duplicates.
-- Test payments (Vercel previews, Stripe test mode, PayPal sandbox, the test gateway) use their own TEST-
-- series, so testing never uses up a real invoice number.
create table if not exists public.invoice_counters (
  series  text primary key check (series in ('invoice','adjustment','test_invoice','test_adjustment')),
  last    integer not null default 0 check (last >= 0)
);
alter table public.invoice_counters drop constraint if exists invoice_counters_series_check;
alter table public.invoice_counters add constraint invoice_counters_series_check check (series in ('invoice','adjustment','test_invoice','test_adjustment'));
insert into public.invoice_counters (series, last) values ('invoice', 0), ('adjustment', 0), ('test_invoice', 0), ('test_adjustment', 0)
on conflict (series) do nothing;

-- ---------- orders: invoice, refund totals and the optional business buyer details ----------
alter table public.orders add column if not exists invoice_number      text;
alter table public.orders add column if not exists invoice_issued_at   timestamptz;
alter table public.orders add column if not exists invoice_pdf_path    text;
alter table public.orders add column if not exists invoice_sent_at     timestamptz;
alter table public.orders add column if not exists refunded_cents      integer not null default 0;
alter table public.orders add column if not exists buyer_business_name text;
alter table public.orders add column if not exists buyer_abn           text;
create unique index if not exists orders_invoice_number_uq on public.orders (invoice_number) where invoice_number is not null;

-- ---------- refunds (and the adjustment note for each one) ----------
create table if not exists public.refunds (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references public.orders(id) on delete cascade,
  provider           text not null check (provider in ('stripe','paypal','simulator')),
  provider_refund_id text,
  amount_cents       integer not null check (amount_cents > 0),
  reason             text,
  note               text,
  source             text not null default 'dashboard' check (source in ('dashboard','stripe','paypal')),
  status             text not null default 'pending' check (status in ('pending','succeeded','failed')),
  failure            text,
  notify_customer    boolean not null default false,
  admin_user_id      uuid,
  admin_email        text,
  request_key        text,
  adjustment_number  text,
  adjustment_issued_at timestamptz,
  adjustment_pdf_path text,
  email_sent_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists refunds_order_idx on public.refunds (order_id);
create unique index if not exists refunds_provider_ref_uq on public.refunds (provider, provider_refund_id) where provider_refund_id is not null;
create unique index if not exists refunds_request_key_uq on public.refunds (request_key) where request_key is not null;
create unique index if not exists refunds_adjustment_uq on public.refunds (adjustment_number) where adjustment_number is not null;

-- ---------- functions (server only) ----------
-- Recalculate an order's refunded total from its succeeded refunds.
create or replace function public.refund_total(p_order uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare t integer;
begin
  select coalesce(sum(amount_cents), 0) into t from public.refunds where order_id = p_order and status = 'succeeded';
  update public.orders set refunded_cents = t where id = p_order;
  return t;
end $$;

-- Reserve a dashboard refund before calling Stripe or PayPal. The order row is locked, so two staff
-- pressing Refund at the same moment can't refund more than was paid. Pending refunds count towards the cap.
create or replace function public.refund_reserve(p_order uuid, p_amount integer, p_reason text, p_note text,
  p_notify boolean, p_admin uuid, p_admin_email text, p_key text) returns public.refunds
language plpgsql security definer set search_path = public as $$
declare o public.orders; r public.refunds; used integer;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if p_key is not null then
    select * into r from public.refunds where request_key = p_key and order_id = p_order;
    if found then return r; end if;          -- the same request sent twice: the first one stands
  end if;
  -- a refund whose result we couldn't confirm must be checked first, so it can never be paid twice
  if exists (select 1 from public.refunds where order_id = p_order and source = 'dashboard' and status = 'pending' and provider_refund_id is null) then
    raise exception 'refund_unconfirmed' using errcode = 'P0001'; end if;
  -- refunded before refunds were tracked here: the amounts aren't known, so no refund from the dashboard
  if (o.status = 'refunded' or o.refunded_at is not null) and not exists (select 1 from public.refunds where order_id = p_order and status = 'succeeded') then
    raise exception 'legacy_refund' using errcode = 'P0001'; end if;
  if o.paid_at is null then raise exception 'not_paid' using errcode = 'P0001'; end if;
  if coalesce(o.provider_ref, '') = '' or o.provider not in ('stripe','paypal','simulator') then
    raise exception 'no_payment_reference' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'bad_amount' using errcode = 'P0001'; end if;
  select coalesce(sum(amount_cents), 0) into used from public.refunds where order_id = p_order and status in ('pending','succeeded');
  if p_amount > o.total_cents - used then raise exception 'over_refund:%', o.total_cents - used using errcode = 'P0001'; end if;
  insert into public.refunds (order_id, provider, amount_cents, reason, note, source, status, notify_customer, admin_user_id, admin_email, request_key)
  values (p_order, o.provider, p_amount, p_reason, p_note, 'dashboard', 'pending', coalesce(p_notify, false), p_admin, p_admin_email, p_key)
  returning * into r;
  return r;
end $$;

-- Record what Stripe or PayPal said about a dashboard refund. If a webhook already recorded the same
-- provider refund as a separate row (it can arrive before the API reply), that row is folded into this one.
create or replace function public.refund_settle(p_id uuid, p_status text, p_provider_refund_id text, p_failure text)
returns public.refunds
language plpgsql security definer set search_path = public as $$
declare r public.refunds; other public.refunds;
begin
  select * into r from public.refunds where id = p_id;
  if not found then raise exception 'refund_not_found' using errcode = 'P0001'; end if;
  perform 1 from public.orders where id = r.order_id for update;
  if p_provider_refund_id is not null then
    select * into other from public.refunds where provider = r.provider and provider_refund_id = p_provider_refund_id and id <> p_id;
    if found then
      if other.adjustment_number is null and other.source <> 'dashboard' then
        delete from public.refunds where id = other.id;
      else   -- the provider's notice was recorded in full first: keep that one, drop this duplicate
        update public.refunds set reason = coalesce(other.reason, r.reason), note = coalesce(other.note, r.note),
          notify_customer = other.notify_customer or r.notify_customer, admin_email = coalesce(other.admin_email, r.admin_email)
        where id = other.id;
        delete from public.refunds where id = p_id;
        perform public.refund_total(r.order_id);
        select * into r from public.refunds where id = other.id;
        return r;
      end if;
    end if;
  end if;
  update public.refunds set status = case when status = 'succeeded' and p_status = 'pending' then status else p_status end,
    provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
    failure = case when p_status = 'failed' then p_failure else null end, updated_at = now()
  where id = p_id returning * into r;
  perform public.refund_total(r.order_id);
  return r;
end $$;

-- A refund reported by a Stripe or PayPal webhook (made in the dashboard or directly in Stripe or PayPal).
-- Never counted twice: matched by the provider's refund id, then by our own refund id (sent to Stripe as
-- metadata and to PayPal as custom_id). Otherwise it's a refund made directly in Stripe or PayPal and is
-- added. A refund the provider later reports as failed is moved to failed. Returns the row, whether it was
-- new, and its status before.
create or replace function public.refund_external(p_order uuid, p_provider text, p_provider_refund_id text,
  p_amount integer, p_status text, p_our_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.refunds; added boolean := false; was text;
begin
  perform 1 from public.orders where id = p_order for update;
  select * into r from public.refunds where provider = p_provider and provider_refund_id = p_provider_refund_id;
  if not found and p_our_id is not null then
    select * into r from public.refunds where id = p_our_id and order_id = p_order
      and (provider_refund_id is null or provider_refund_id = p_provider_refund_id);
  end if;
  if found then
    was := r.status;
    update public.refunds set provider_refund_id = coalesce(provider_refund_id, p_provider_refund_id),
      status = case when status = 'succeeded' and p_status = 'pending' then status else p_status end,
      failure = case when p_status = 'failed' then coalesce(failure, 'The refund failed at the payment provider.') else failure end,
      updated_at = now()
    where id = r.id returning * into r;
  else
    insert into public.refunds (order_id, provider, provider_refund_id, amount_cents, reason, source, status)
    values (p_order, p_provider, p_provider_refund_id, p_amount, case p_provider when 'stripe' then 'Refunded in Stripe' else 'Refunded in PayPal' end,
            p_provider, p_status)
    returning * into r;
    added := true; was := null;
  end if;
  perform public.refund_total(p_order);
  return jsonb_build_object('refund', to_jsonb(r), 'added', added, 'was', was);
end $$;

drop function if exists public.invoice_assign(uuid);        -- an earlier draft took no test flag
drop function if exists public.adjustment_assign(uuid);
-- Give a paid order its tax invoice number (AV-000001, AV-000002, ...). Safe to call again: an order
-- that already has a number keeps it. Dated with the payment date.
create or replace function public.invoice_assign(p_order uuid, p_test boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare o public.orders; n integer; num text;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.invoice_number is not null then return o.invoice_number; end if;
  if o.paid_at is null then raise exception 'not_paid' using errcode = 'P0001'; end if;
  update public.invoice_counters set last = last + 1 where series = case when p_test then 'test_invoice' else 'invoice' end returning last into n;
  if n is null then raise exception 'invoice_counter_missing' using errcode = 'P0001'; end if;
  num := case when p_test then 'TEST-AV-' else 'AV-' end || lpad(n::text, 6, '0');
  update public.orders set invoice_number = num, invoice_issued_at = o.paid_at where id = p_order;
  return num;
end $$;

-- Give a succeeded refund its adjustment note number (AN-000001, ...). Safe to call again.
create or replace function public.adjustment_assign(p_refund uuid, p_test boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare r public.refunds; n integer; num text;
begin
  select * into r from public.refunds where id = p_refund for update;
  if not found then raise exception 'refund_not_found' using errcode = 'P0001'; end if;
  if r.adjustment_number is not null then return r.adjustment_number; end if;
  if r.status <> 'succeeded' then raise exception 'not_succeeded' using errcode = 'P0001'; end if;
  update public.invoice_counters set last = last + 1 where series = case when p_test then 'test_adjustment' else 'adjustment' end returning last into n;
  if n is null then raise exception 'invoice_counter_missing' using errcode = 'P0001'; end if;
  num := case when p_test then 'TEST-AN-' else 'AN-' end || lpad(n::text, 6, '0');
  update public.refunds set adjustment_number = num, adjustment_issued_at = now() where id = p_refund;
  return num;
end $$;

revoke all on function public.refund_total(uuid) from public, anon, authenticated;
revoke all on function public.refund_reserve(uuid, integer, text, text, boolean, uuid, text, text) from public, anon, authenticated;
revoke all on function public.refund_settle(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.refund_external(uuid, text, text, integer, text, uuid) from public, anon, authenticated;
revoke all on function public.invoice_assign(uuid, boolean) from public, anon, authenticated;
revoke all on function public.adjustment_assign(uuid, boolean) from public, anon, authenticated;
grant execute on function public.refund_total(uuid) to service_role;
grant execute on function public.refund_reserve(uuid, integer, text, text, boolean, uuid, text, text) to service_role;
grant execute on function public.refund_settle(uuid, text, text, text) to service_role;
grant execute on function public.refund_external(uuid, text, text, integer, text, uuid) to service_role;
grant execute on function public.invoice_assign(uuid, boolean) to service_role;
grant execute on function public.adjustment_assign(uuid, boolean) to service_role;

-- ---------- access: no public access at all; admins read and write; the server role for webhooks ----------
alter table public.business_details enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.refunds enable row level security;
drop policy if exists "admin all" on public.business_details;
create policy "admin all" on public.business_details for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin read" on public.invoice_counters;
create policy "admin read" on public.invoice_counters for select to authenticated using (public.is_admin());
drop policy if exists "admin read" on public.refunds;
create policy "admin read" on public.refunds for select to authenticated using (public.is_admin());
revoke all on public.business_details, public.invoice_counters, public.refunds from anon;
revoke insert, update, delete on public.invoice_counters, public.refunds from authenticated;
grant all on public.business_details, public.invoice_counters, public.refunds to service_role;

-- ---------- private bucket for invoice and adjustment note PDFs (and the invoice logo) ----------
-- Never public: files are only handed out through signed links that expire.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 5242880, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;
drop policy if exists "invoices staff read" on storage.objects;
create policy "invoices staff read" on storage.objects for select to authenticated using (bucket_id = 'invoices' and public.is_admin());

select 'Refunds and invoices ready: ' || (select count(*) from public.refunds) || ' refund(s), next invoice number AV-'
  || lpad(((select last from public.invoice_counters where series = 'invoice') + 1)::text, 6, '0') as result;
