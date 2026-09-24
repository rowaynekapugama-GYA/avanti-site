-- =====================================================================
-- GYA CMS schema for Supabase (v1)
-- Reusable across GYA single-file SPA builds. Run once in a new project:
--   Supabase dashboard > SQL editor > paste this file > Run.
-- Safe to re-run: tables use "if not exists", policies and functions
-- are dropped and recreated.
--
-- Access model
--   anon visitors   read published rows only, can upload customer artwork
--   admin staff     full read and write (profiles.role = 'admin')
--   service role    seed script only, never in the browser
-- Staff accounts are created in Authentication > Users (sign-ups off),
-- then promoted with:
--   insert into public.profiles (user_id, role, display_name)
--   select id, 'admin', 'Name' from auth.users where email = 'staff@example.com';
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- helpers --------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- JSON helpers for the save functions: a JSON null becomes SQL NULL, and a JSON
-- array becomes a text[] (an empty array stays empty rather than turning NULL).
create or replace function public.jnull(j jsonb) returns jsonb language sql immutable as
  $$ select case when j is null or jsonb_typeof(j) = 'null' then null else j end $$;
create or replace function public.jtext_array(j jsonb) returns text[] language sql immutable as
  $$ select case when jsonb_typeof(j) = 'array' then array(select jsonb_array_elements_text(j)) else null end $$;

-- ---------- staff profiles --------------------------------------------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'editor' check (role in ('admin','editor')),
  display_name text,
  created_at   timestamptz not null default now()
);

-- security definer so it can read profiles without tripping RLS recursion
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin');
$$;

-- ---------- shipping ---------------------------------------------------
create table if not exists public.shipping_classes (
  slug       text primary key,
  label      text not null,
  courier    boolean not null default false,
  note       text,
  position   int not null default 0,
  updated_at timestamptz not null default now()
);
create table if not exists public.shipping_rates (
  id         bigint generated always as identity primary key,
  class_slug text not null references public.shipping_classes(slug) on update cascade on delete cascade,
  label      text not null,
  amount     numeric(10,2) not null check (amount >= 0),
  position   int not null default 0
);

-- ---------- catalogue ------------------------------------------------------
create table if not exists public.categories (
  slug           text primary key,
  name           text not null,
  group_name     text,
  blurb          text,
  image_url      text,
  shipping_class text references public.shipping_classes(slug) on update cascade on delete set null,
  position       int not null default 0,
  published      boolean not null default true,
  updated_at     timestamptz not null default now()
);

create table if not exists public.products (
  slug                text primary key,
  name                text not null,
  category_slug       text not null references public.categories(slug) on update cascade,
  summary             text,
  description_html    text,
  pricing_mode        text not null default 'fixed'
                      check (pricing_mode in ('fixed','tiered','variation','per_m2','custom_dims')),
  base_price          numeric(10,2) not null default 0 check (base_price >= 0),
  price_max           numeric(10,2),
  unit_label          text,
  wall_dims           boolean not null default false,  -- width x height entry, priced per m2
  dims_config         jsonb,                           -- custom dimensions limits, e.g. {"maxW":1200}
  variation_keys      text[],                          -- options that drive price, in lookup order
  tags                text[],
  sold_out            boolean not null default false,
  has_personalisation boolean not null default false,
  personalisation     jsonb,                           -- order form fields (text, font, date, fixed)
  swatches            jsonb,                           -- colour name -> hex
  preview_text        text,
  position            int not null default 0,
  published           boolean not null default true,
  updated_at          timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_slug, position);

create table if not exists public.product_options (
  id           bigint generated always as identity primary key,
  product_slug text not null references public.products(slug) on update cascade on delete cascade,
  name         text not null,
  choices      text[] not null default '{}',
  position     int not null default 0,
  unique (product_slug, name)
);
create table if not exists public.product_variations (
  id            bigint generated always as identity primary key,
  product_slug  text not null references public.products(slug) on update cascade on delete cascade,
  option_values jsonb not null,             -- {"Material":"3mm","Size":"A1"}
  price         numeric(10,2) not null check (price >= 0),
  available     boolean not null default true,
  position      int not null default 0,
  unique (product_slug, option_values)
);
create table if not exists public.product_price_tiers (
  id           bigint generated always as identity primary key,
  product_slug text not null references public.products(slug) on update cascade on delete cascade,
  min_qty      int not null check (min_qty >= 1),
  unit_price   numeric(10,2) not null check (unit_price >= 0),
  unique (product_slug, min_qty)
);
create table if not exists public.product_images (
  id           bigint generated always as identity primary key,
  product_slug text not null references public.products(slug) on update cascade on delete cascade,
  url          text not null,
  fallback_url text,                         -- used if url fails to load (legacy live-site copy)
  alt          text,
  position     int not null default 0
);
create table if not exists public.product_templates (
  id           bigint generated always as identity primary key,
  product_slug text not null references public.products(slug) on update cascade on delete cascade,
  label        text not null,
  url          text not null,
  size_key     text,                         -- matches the chosen size for filtering
  position     int not null default 0
);

-- ---------- content ------------------------------------------------------------
create table if not exists public.blog_posts (
  slug         text primary key,
  title        text not null,
  excerpt      text,
  body_html    text,                         -- empty = link out to legacy_url
  cover_url    text,
  legacy_url   text,
  published_at date,
  published    boolean not null default true,
  updated_at   timestamptz not null default now()
);
create table if not exists public.pages (
  slug       text primary key,
  title      text not null,
  body_html  text,
  published  boolean not null default true,
  updated_at timestamptz not null default now()
);
create table if not exists public.faqs (
  id       bigint generated always as identity primary key,
  set_key  text not null,
  question text not null,
  answer   text not null,
  position int not null default 0
);
create table if not exists public.seo_entries (
  route       text primary key,              -- '/', '/shop/corflute', '/product/x', '/blog/y'
  title       text,
  description text,
  og_image    text,
  updated_at  timestamptz not null default now()
);
create table if not exists public.site_settings (
  key        text primary key,               -- 'content', 'category_groups', 'ship_note', ...
  value      jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.media (
  id         bigint generated always as identity primary key,
  bucket     text not null default 'media',
  path       text not null unique,
  url        text not null,
  alt        text,
  mime       text,
  bytes      bigint,
  created_at timestamptz not null default now()
);

-- ---------- updated_at triggers --------------------------------------------
do $$ declare t text; begin
  foreach t in array array['shipping_classes','categories','products','blog_posts','pages','seo_entries','site_settings'] loop
    execute format('drop trigger if exists %I_updated on public.%I', t, t);
    execute format('create trigger %I_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------- privileges (Supabase grants these by default; explicit for clarity) --
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------- row level security -------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['profiles','shipping_classes','shipping_rates','categories','products',
    'product_options','product_variations','product_price_tiers','product_images','product_templates',
    'blog_posts','pages','faqs','seo_entries','site_settings','media'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "read" on public.%I', t);
    execute format('drop policy if exists "admin write" on public.%I', t);
    execute format('create policy "admin write" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- published parents: visitors see published rows, admins see everything
create policy "read" on public.categories for select using (published or public.is_admin());
create policy "read" on public.products   for select using (published or public.is_admin());
create policy "read" on public.blog_posts for select using (published or public.is_admin());
create policy "read" on public.pages      for select using (published or public.is_admin());

-- children follow their product
do $$ declare t text; begin
  foreach t in array array['product_options','product_variations','product_price_tiers','product_images','product_templates'] loop
    execute format('create policy "read" on public.%I for select using (exists (select 1 from public.products p where p.slug = product_slug and (p.published or public.is_admin())))', t);
  end loop;
end $$;

-- always public
create policy "read" on public.shipping_classes for select using (true);
create policy "read" on public.shipping_rates   for select using (true);
create policy "read" on public.faqs             for select using (true);
create policy "read" on public.seo_entries      for select using (true);
create policy "read" on public.site_settings    for select using (true);
create policy "read" on public.media            for select using (true);

-- staff see their own profile (the admin check at login), admins see all
create policy "read" on public.profiles for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- ---------- save a product in one transaction -------------------------------------
-- The admin dashboard and the seed script both call this, so every save follows
-- one code path. From/to prices are recalculated from available variations.
create or replace function public.admin_save_product(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare s text := p->>'slug'; old_s text := coalesce(p->>'original_slug', p->>'slug');
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if s is null or s !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then raise exception 'Invalid slug: %', s; end if;

  if old_s <> s and exists (select 1 from products where slug = old_s) then
    update products set slug = s where slug = old_s;       -- children follow via on update cascade
  end if;

  insert into products (slug, name, category_slug, summary, description_html, pricing_mode, base_price,
    price_max, unit_label, wall_dims, dims_config, variation_keys, tags, sold_out, has_personalisation,
    personalisation, swatches, preview_text, position, published)
  values (s, p->>'name', p->>'category_slug', p->>'summary', p->>'description_html',
    coalesce(p->>'pricing_mode','fixed'), coalesce((p->>'base_price')::numeric, 0),
    (p->>'price_max')::numeric, p->>'unit_label', coalesce((p->>'wall_dims')::boolean, false),
    jnull(p->'dims_config'), jtext_array(p->'variation_keys'), jtext_array(p->'tags'),
    coalesce((p->>'sold_out')::boolean, false), coalesce((p->>'has_personalisation')::boolean, false),
    jnull(p->'personalisation'), jnull(p->'swatches'), p->>'preview_text', coalesce((p->>'position')::int, 0),
    coalesce((p->>'published')::boolean, true))
  on conflict (slug) do update set name = excluded.name, category_slug = excluded.category_slug,
    summary = excluded.summary, description_html = excluded.description_html,
    pricing_mode = excluded.pricing_mode, base_price = excluded.base_price, price_max = excluded.price_max,
    unit_label = excluded.unit_label, wall_dims = excluded.wall_dims, dims_config = excluded.dims_config,
    variation_keys = excluded.variation_keys, tags = excluded.tags, sold_out = excluded.sold_out,
    has_personalisation = excluded.has_personalisation, personalisation = excluded.personalisation,
    swatches = excluded.swatches, preview_text = excluded.preview_text, position = excluded.position,
    published = excluded.published;

  delete from product_options     where product_slug = s;
  delete from product_variations  where product_slug = s;
  delete from product_price_tiers where product_slug = s;
  delete from product_images      where product_slug = s;
  delete from product_templates   where product_slug = s;

  insert into product_options (product_slug, name, choices, position)
    select s, o->>'name', coalesce(jtext_array(o->'choices'), '{}'), i - 1
    from jsonb_array_elements(coalesce(jnull(p->'options'), '[]')) with ordinality as t(o, i);
  insert into product_variations (product_slug, option_values, price, available, position)
    select s, v->'option_values', (v->>'price')::numeric, coalesce((v->>'available')::boolean, true), i - 1
    from jsonb_array_elements(coalesce(jnull(p->'variations'), '[]')) with ordinality as t(v, i);
  insert into product_price_tiers (product_slug, min_qty, unit_price)
    select s, (x->>'min_qty')::int, (x->>'unit_price')::numeric
    from jsonb_array_elements(coalesce(jnull(p->'tiers'), '[]')) x;
  insert into product_images (product_slug, url, fallback_url, alt, position)
    select s, m->>'url', m->>'fallback_url', m->>'alt', i - 1
    from jsonb_array_elements(coalesce(jnull(p->'images'), '[]')) with ordinality as t(m, i);
  insert into product_templates (product_slug, label, url, size_key, position)
    select s, x->>'label', x->>'url', x->>'size_key', i - 1
    from jsonb_array_elements(coalesce(jnull(p->'templates'), '[]')) with ordinality as t(x, i);

  -- variation-priced products: from/to prices always follow the grid
  update products set
    base_price = coalesce((select min(price) from product_variations where product_slug = s and available), base_price),
    price_max  = (select max(price) from product_variations where product_slug = s and available)
  where slug = s and exists (select 1 from product_variations where product_slug = s);

  return (select to_jsonb(pr) from products pr where slug = s);
end $$;

-- ---------- save all shipping classes and rates in one transaction -------------------
-- payload: {"classes":[{"slug","label","courier","note","rates":[{"label","amount"}],"categories":["slug"]}]}
create or replace function public.admin_save_shipping(payload jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare c jsonb; i int := 0;
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode = '42501'; end if;
  update categories set shipping_class = null where shipping_class is not null;
  delete from shipping_classes
    where slug not in (select x->>'slug' from jsonb_array_elements(payload->'classes') x);
  for c in select * from jsonb_array_elements(payload->'classes') loop
    insert into shipping_classes (slug, label, courier, note, position)
    values (c->>'slug', c->>'label', coalesce((c->>'courier')::boolean, false), c->>'note', i)
    on conflict (slug) do update set label = excluded.label, courier = excluded.courier,
      note = excluded.note, position = excluded.position;
    delete from shipping_rates where class_slug = c->>'slug';
    insert into shipping_rates (class_slug, label, amount, position)
      select c->>'slug', r->>'label', (r->>'amount')::numeric, j - 1
      from jsonb_array_elements(coalesce(jnull(c->'rates'), '[]')) with ordinality as t(r, j);
    update categories set shipping_class = c->>'slug'
      where slug in (select jsonb_array_elements_text(coalesce(jnull(c->'categories'), '[]')));
    i := i + 1;
  end loop;
end $$;

-- ---------- replace one FAQ set in one transaction ---------------------------------------
create or replace function public.admin_save_faqs(set_key text, items jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Not allowed' using errcode = '42501'; end if;
  delete from faqs f where f.set_key = admin_save_faqs.set_key;
  insert into faqs (set_key, question, answer, position)
    select admin_save_faqs.set_key, q->>'question', q->>'answer', i - 1
    from jsonb_array_elements(items) with ordinality as t(q, i);
end $$;

revoke execute on function public.admin_save_product(jsonb) from anon;
revoke execute on function public.admin_save_shipping(jsonb) from anon;
revoke execute on function public.admin_save_faqs(text, jsonb) from anon;
grant execute on function public.admin_save_product(jsonb), public.admin_save_shipping(jsonb),
  public.admin_save_faqs(text, jsonb) to authenticated;

-- ---------- storage buckets ------------------------------------------------------
-- media:   product images, blog images, template PDFs. Public read, admin write.
-- artwork: customer print files. Anyone may upload into incoming/, nobody may
--          overwrite, only staff may read or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 10485760,
        array['image/jpeg','image/png','image/webp','image/gif','image/svg+xml','application/pdf']),
       ('artwork', 'artwork', false, 33554432,
        array['application/pdf','image/jpeg','image/png','image/tiff','application/postscript',
              'image/vnd.adobe.photoshop','application/illustrator','application/octet-stream'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "media read"     on storage.objects;
drop policy if exists "media write"    on storage.objects;
drop policy if exists "media update"   on storage.objects;
drop policy if exists "media delete"   on storage.objects;
drop policy if exists "artwork upload" on storage.objects;
drop policy if exists "artwork staff"  on storage.objects;
drop policy if exists "artwork delete" on storage.objects;

create policy "media read"   on storage.objects for select using (bucket_id = 'media');
create policy "media write"  on storage.objects for insert to authenticated with check (bucket_id = 'media' and public.is_admin());
create policy "media update" on storage.objects for update to authenticated using (bucket_id = 'media' and public.is_admin());
create policy "media delete" on storage.objects for delete to authenticated using (bucket_id = 'media' and public.is_admin());
create policy "artwork upload" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'artwork' and (storage.foldername(name))[1] = 'incoming');
create policy "artwork staff"  on storage.objects for select to authenticated using (bucket_id = 'artwork' and public.is_admin());
create policy "artwork delete" on storage.objects for delete to authenticated using (bucket_id = 'artwork' and public.is_admin());
