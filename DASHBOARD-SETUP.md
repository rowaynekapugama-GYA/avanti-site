# Staff dashboard: setup guide

The site now has a staff login (`/#/login`) and a dashboard (`/#/admin`). Staff can edit
prices (including every size and material combination), product descriptions, photos,
shipping and delivery wording, site text, SEO titles and descriptions, FAQs, pages and
blog posts. Saved changes are live on the next page load, with no redeploy.

Until the steps below are done, the site runs exactly as before on the data built into
`index.html`, and the login page says it isn't connected yet.

## Trying it first (demo mode)

Before any of the setup below, the dashboard can be tried at `/#/login` with username
`teamGYA` and password `avantisite2026`. Everything works, but changes are saved only in the
browser you're using: nobody else sees them and nothing goes live. **Reset demo** in the
sidebar puts everything back. Anyone can read the demo login in the page code, so before the
site goes live set `demo: false` in the config block. Step 5 below also switches it off.

Setup takes about 15 minutes.

## 1. Create the Supabase project

1. Sign in at supabase.com. We suggest one GYA organisation that holds every client project.
2. New project. Name it `avanti`, region **Sydney (ap-southeast-2)**, and save the database
   password somewhere safe.
3. Plan: the free plan pauses a project after a week with no visits to the database, which
   would take the dashboard offline (the shop itself keeps working on built-in data).
   Use the Pro plan (about US$25 a month per organisation) for anything client-facing.

## 2. Create the tables

1. In the project, open **SQL Editor**, then **New query**.
2. Paste the whole of `scripts/supabase-schema.sql` and click **Run**.
3. It should finish with "Success. No rows returned". It's safe to run again later.

This creates the tables, the security rules and two storage buckets: `media` (site photos,
public) and `artwork` (customer uploads, private to staff).

## 3. Turn off public sign-ups

**Authentication > Sign In / Providers > Email**: switch off **Allow new users to sign up**.
Staff accounts are created by you, never by visitors.

## 4. Load the current products and content

On your own computer (needs Node 18 or newer), in the site folder:

```
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=your-secret-key node scripts/seed.mjs
```

Both values are under **Project Settings > API** (the secret one is labelled
**service_role** or **secret**). Add `--dry-run` first if you want to check the file
without writing anything. It's safe to run twice.

The secret key can do anything to the database. Only ever use it in this command. Never
put it in `index.html`, an email, Slack or git.

## 5. Connect the site

Open `index.html` and find the block near the top marked `GYA CMS config`. Fill in:

```
supabaseUrl: 'https://xxxx.supabase.co',
anonKey: 'the anon public or publishable key',
```

The anon key is meant to be public; the security rules are what protect the data. Deploy
the folder as usual.

## 6. Add staff accounts

1. **Authentication > Users > Add user > Create new user**. Enter their email and a
   temporary password, and tick **Auto Confirm User**.
2. In **SQL Editor**, give them dashboard access:

```
insert into public.profiles (user_id, role, display_name)
select id, 'admin', 'Their Name' from auth.users where email = 'them@avantiprint.com.au'
on conflict (user_id) do update set role = 'admin', display_name = excluded.display_name;
```

Only accounts with the `admin` role can open the dashboard. Anyone else who signs in is
told they don't have access. To remove someone, delete them under **Authentication > Users**.

## Using the dashboard

- **Products**: name, category, descriptions, published and sold-out switches, options,
  quantity price breaks, photos, templates, personalisation fields and SEO. Products with
  sizes or materials have a **price grid** with a price for every combination. You can
  change every price by a percentage, or paste prices straight from a spreadsheet (one
  combination per line, price last). The "from" price is worked out automatically.
- **Categories** and **Shipping**: names, blurbs, images, order, delivery rates and the
  delivery wording.
- **Blog**: all 87 existing posts with their Google titles and descriptions, plus new posts with a cover image, rich text and SEO.
- **Pages & FAQs**: terms, privacy and every FAQ list.
- **Site wording & images**: the top bar messages, homepage slides, About, Contact and
  footer text. Each item has **Reset to original**.
- **SEO**: every page's title, description and share image in one table, flagging
  anything missing or too long.
- **Media**: upload and reuse images and PDFs.
- **Account & tools**: **Download seed data** exports everything, for backups or a fresh project.

If you leave a page with unsaved changes, the dashboard asks first.

## If the database is down

The shop keeps working on the data built into `index.html`. That copy only changes when we
release a new version, so after big dashboard edits, download the seed data from
**Account & tools** and send it to us to fold into the next release.

## Things to know

- SEO fields apply to the page as it loads. Google reads them, but some social sites
  (Facebook, LinkedIn) only read the first HTML file and will show the homepage's title and
  image for every link until the site moves to real page addresses. That's a separate
  piece of work we've recommended.
- When real online payment is added, the order total must be recalculated on the server
  from these prices rather than trusted from the browser.
