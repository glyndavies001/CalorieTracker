# CalorieTracker

A small installable web app for tracking calories, protein, carbs, fat and body weight.

- **Today** – a diary by meal, with totals against daily targets
- **Foods** – values typed straight from the label (per 100 g, per serving or per item)
- **Dishes** – recipes built from the foods list; totals per portion or per cooked weight, updated whenever a food changes
- **Weight** – daily weigh-ins in kg or stones and pounds, with a trend chart and goal

## How it's built

Plain HTML and JavaScript with no build step: `index.html`, `app.js`, `sw.js` (network-first
service worker), `manifest.json`, the icons, and `vendor/supabase.js` (Supabase JS 2.49.4).

Data lives in the same Supabase project as Vaulted, in the `ct_foods`, `ct_dishes`, `ct_diary`,
`ct_weights` and `ct_settings` tables. Row-level security keeps every row private to the
account that created it, so sign in with an existing Vaulted login.

Diary entries store the calories and macros as they were when logged, so editing a food later
doesn't change past days.

## Deploying

Vercel, framework preset **Other**, no build command, output directory `.` — every push to
`main` deploys. Bump `APP_VERSION` in `app.js` with each change (shown in Settings).
