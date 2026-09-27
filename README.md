# CalorieTracker

A small installable web app for tracking calories, protein, carbs, fat and body weight.

- **Today** – a diary by meal, with totals against daily targets; switch to **Month** for a chart of each
  day's calories against the target (over-target days in red), the month's averages, days under/over and
  the weight change, with a tap on any day to open it
- **Foods** – values typed straight from the label (per 100 g, per serving or per item), or filled in by scanning the barcode
- **Dishes** – recipes built from the foods list; totals per portion or per cooked weight, updated whenever a food changes
- **Weight** – daily weigh-ins in kg or stones and pounds, with a trend chart and goal

Handy details:

- **Barcode scanning** – scan when adding to the diary or on the Foods tab. The household's foods are checked
  first, then [Open Food Facts](https://world.openfoodfacts.org) (a free, open product database); a found product
  opens pre-filled to check and save. The barcode is kept on the food, so the next scan finds it straight away.
  Phones with a built-in barcode reader (Android) use it; others (iPhone) use ZXing, downloaded on first use.
- **Fixed portions** – a food can have a set amount (e.g. one pack of noodles); tapping it adds it in one go, with Undo.
- **Remembered amounts** – adding a food or dish starts at the amount you last logged for it.
- **Sorting** – Foods and Dishes can be sorted A–Z or by how often you log them (remembered on each device).
- **Fitbit: calories burned and steps** – each person can connect their Fitbit (Settings). Total calories
  burned and steps per day come from the Google Health API and show on the Day view (burned with the deficit
  or surplus; steps against the step goal, 10,000 unless changed in Settings) and the Month view (a burned
  line over the columns, average burned and steps, days the step goal was hit). The `fitbit` Supabase Edge
  Function (`supabase/functions/fitbit`) handles the Google sign-in and fetches the numbers into `ct_burn`;
  refresh tokens live in `ct_fit_links`, and the Google OAuth client id/secret in `ct_config` — both
  readable only by the server.
- **Health tab** – Steps, Sleep and Heart rate cards, each opening a full-screen page:
  - *Steps*: a big number that keeps climbing at your pace between watch syncs (from the last few minutes of
    minute-by-minute steps), corrected at each sync; pace, when you'll reach the goal, when the watch last synced.
    Keeps the screen on while open.
  - *Sleep*: a night's stages (awake, REM, light, deep) on a timeline, the last 14 nights with the average; tap a
    night to see it.
  - *Heart rate*: resting heart rate over 30 days, and today in 5-minute steps (average line, range band).
  Pages refresh every 20 seconds while open. Sleep and heart rate need two extra Google permissions (granted
  when connecting; `ct_settings.fit_scopes` records which), and are fetched when shown, not stored.
  "Watch synced" times come from the latest minute of activity data Google has (`ct_settings.fit_synced_at`).
- **Step reminder** – each phone can opt in (Settings → Step reminder, with a time from 5pm to 10pm). A
  database job (`ct-step-reminder`, pg_cron + pg_net) calls the function every hour with a secret header
  (`cron_key` in `ct_config`); whoever's reminder hour it is (UK time) gets a fresh step count and, if under
  their goal, a notification (Web Push, encrypted, signed with a VAPID key pair the function makes on first
  use and keeps in `ct_config`). Phones' subscriptions are in `ct_push_subs`. On iPhone this works only when
  the app is on the Home Screen (iOS 16.4+).

## How it's built

Plain HTML and JavaScript with no build step: `index.html`, `app.js`, `sw.js` (network-first
service worker), `manifest.json`, the icons, `vendor/supabase.js` (Supabase JS 2.49.4) and
`vendor/zxing.min.js` (@zxing/library 0.23.0, Apache-2.0, only loaded when scanning).

Data lives in the same Supabase project as Vaulted, in the `ct_foods`, `ct_dishes`, `ct_diary`,
`ct_weights` and `ct_settings` tables; sign in with an existing Vaulted login. Foods and dishes
are one list shared by the household (either account can add, edit or delete); the diary,
weights and settings are private to each account (row-level security). A barcode can belong
to only one food.

Diary entries store the calories and macros as they were when logged, so editing a food later
doesn't change past days.

## Deploying

Vercel, framework preset **Other**, no build command, output directory `.` — every push to
`main` deploys. Bump `APP_VERSION` in `app.js` with each change (shown in Settings).
