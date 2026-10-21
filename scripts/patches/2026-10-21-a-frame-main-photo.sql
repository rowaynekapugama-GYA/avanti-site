-- Avanti: new main photo for the Corflute Insertable A-Frame (21 October 2026)
-- Paste the whole file into Supabase > SQL Editor > New query, then Run. Safe to run again.
-- Only changes the A-frame's first photo. Everything else is left alone.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update public.product_images
   set url = 'assets/products/corflute-insertable-a-frame-main.jpg',
       alt = 'Corflute insertable A-frame sign with a black frame and printed corflute insert'
 where product_slug = 'corflute-insertable-a-frame'
   and position = 0;

commit;

-- Check: should say OK
select 'A-frame main photo' as item,
       case when count(*) = 1 then 'OK' else 'CHECK' end as result
  from public.product_images
 where product_slug = 'corflute-insertable-a-frame' and position = 0
   and url = 'assets/products/corflute-insertable-a-frame-main.jpg';
