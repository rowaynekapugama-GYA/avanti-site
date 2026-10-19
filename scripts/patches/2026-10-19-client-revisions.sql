-- Avanti client revisions, 19 October 2026 (Joey's email "Website Updates")
-- Applies the same changes as the website update to the live database, so customers see them.
-- Paste the whole file into Supabase > SQL Editor > New query, then Run. Safe to run again.
-- It only touches: the photos of 7 products, 2 FAQ answers, 1 blog post sentence, and any
-- saved site-wording overrides that still mention the showroom. Prices and everything else are left alone.

begin;
-- act as the server for this transaction only
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1. Corflute Insertable A-Frame: the correct photos supplied by Avanti
delete from public.product_images where product_slug = 'corflute-insertable-a-frame';
insert into public.product_images (product_slug, url, fallback_url, alt, position) values
  ('corflute-insertable-a-frame', 'assets/products/corflute-insertable-a-frame-1.jpg', null, 'Corflute insertable A-frame sign with a black frame and printed corflute insert', 0),
  ('corflute-insertable-a-frame', 'assets/products/corflute-insertable-a-frame-2.jpg', null, 'Three corflute insertable A-frame signs with black frames and printed corflute inserts', 1);

-- 2. Custom-size listings lead with a different real photo from the standard listing.
--    The chosen photo moves to the front; the rest keep their order. Standard listings are not touched.
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/Acm-7.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'acm-panels-custom-dimensions') r
  where pi.id = r.id;
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/corflute-4.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'corflute-signs-custom-dimensions') r
  where pi.id = r.id;
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/floor-decols-4.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'floor-decals-custom') r
  where pi.id = r.id;
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/foam-board-6.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'foamboard-custom') r
  where pi.id = r.id;
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/posters-4.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'posters-custom') r
  where pi.id = r.id;
update public.product_images pi set position = r.np
  from (select id, row_number() over (order by (url = 'assets/products/window-graphics-3.jpg') desc, position, id) - 1 as np
        from public.product_images where product_slug = 'window-graphics-custom-dimensions') r
  where pi.id = r.id;

-- 3. Contact page FAQs
update public.faqs set answer = 'We deliver Australia-wide. The carrier we use depends on the size of your order. Smaller items are generally sent with Australia Post, while larger and bulkier products such as A-frames, large signage and corflute boards are sent with trusted external courier and freight companies. If you have a question about delivery for a specific order, please call us on 02 9729 0139 or email info@avantiprint.com.au.'
  where set_key = 'general' and question = 'How do you ship my orders?';
update public.faqs set answer = 'No, we don''t have a showroom, and we''re unable to accept walk-ins or in-person pickups. All orders are handled online, by phone and by email, and delivered to you. Our team is happy to help with any questions on 02 9729 0139 or info@avantiprint.com.au.'
  where set_key = 'general' and question = 'Do you have a showroom?';

-- 4. Blog post: remove the line offering pickup from the Smithfield factory
update public.blog_posts set body_html = replace(body_html, '
If you prefer, you can pick up your product at our Smithfield <a href="https://www.facebook.com/avantiprintanddesigns/">custom cake topper</a> factory.', '')
  where slug = 'where-to-find-a-personalised-cake-topper-in-australia';

-- 5. Site wording saved in the dashboard: drop any override that still mentions the showroom,
--    walk-ins or pickup, so the corrected wording from the website update shows instead
update public.site_settings set value = (
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(value) e(k, v)
    where not (k in ('footer.showroom', 'contact.showroom')
               or v::text ~* '(show ?room|walk-?ins?|pick ?-?ups?|in-store)'))
  where key = 'content' and jsonb_typeof(value) = 'object';

commit;

-- Check: every row should say OK
select 'A-frame photos' as item, case when count(*) = 2 and min(url) like '%corflute-insertable-a-frame-1.jpg' then 'OK' else 'CHECK' end as result
  from public.product_images where product_slug = 'corflute-insertable-a-frame'
union all
select 'Custom-size main photos', case when count(*) = 6 then 'OK' else 'CHECK' end
  from public.product_images where position = 0 and (product_slug, url) in (('acm-panels-custom-dimensions', 'assets/products/Acm-7.jpg'), ('corflute-signs-custom-dimensions', 'assets/products/corflute-4.jpg'), ('floor-decals-custom', 'assets/products/floor-decols-4.jpg'), ('foamboard-custom', 'assets/products/foam-board-6.jpg'), ('posters-custom', 'assets/products/posters-4.jpg'), ('window-graphics-custom-dimensions', 'assets/products/window-graphics-3.jpg'))
union all
select 'Shipping FAQ', case when count(*) = 1 then 'OK' else 'CHECK' end
  from public.faqs where set_key = 'general' and question = 'How do you ship my orders?' and answer like 'We deliver Australia-wide.%'
union all
select 'Showroom FAQ', case when count(*) = 1 then 'OK' else 'CHECK' end
  from public.faqs where set_key = 'general' and question = 'Do you have a showroom?' and answer like 'No, we don''t have a showroom%'
union all
select 'Blog pickup line removed', case when count(*) = 1 then 'OK' else 'CHECK' end
  from public.blog_posts where slug = 'where-to-find-a-personalised-cake-topper-in-australia' and body_html not like '%pick up your product%';
