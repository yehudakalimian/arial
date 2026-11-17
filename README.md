# אריאל · מעקב תינוק משותף (PWA)

A mobile-first, Hebrew (RTL) Progressive Web App that two exhausted parents, יהודה and הדס, share in real time to track their son אריאל. It brings together:

- Nara-style one-tap action grid
- Huckleberry-style adaptive **SweetSpot** nap predictor
- Talli-style "zero typing" logging

The data layer is offline-first: IndexedDB plus an outbox that syncs to Supabase (Postgres, Auth, Realtime, Edge Functions).

The app works **immediately with no backend**. On first load it seeds 14 days of realistic data for אריאל (born 14.10.2026; 4,450 g, 54.5 cm, head 37.5 cm), with parents יהודה and הדס. In this demo mode, every open tab or window stays in live sync through `BroadcastChannel`, including timers and presence. To share between two phones, connect Supabase (see below).

## Run locally

```bash
npm start            # = python3 -m http.server 5173  (any static server works)
# open http://localhost:5173  — use a phone-sized viewport, or "Add to Home Screen" on iOS
npm test             # 9 unit tests for the clinical/business logic (node:test, no deps)
npm i && npm run test:db   # runs the SQL migration in PGlite and checks RLS / RPCs / triggers (16 checks)
```

There is no build step. The app is plain ES modules, and the only runtime dependency is `supabase-js`. It is lazy-loaded from a pinned CDN URL only when cloud sync is configured, and the service worker caches it.

## Feature map

| Spec | Where |
|---|---|
| OLED night palette (`#000`, amber `#F59E0B`, orange `#EA580C`, crimson `#EF4444`), Heebo + JetBrains Mono, night/day and right/left-hand toggles | `styles.css`, top bar in `js/app.js` |
| 3-zone 100dvh screen: read-only status (top), timeline and quick-offset chips (middle), 6 tiles and nav (bottom) | `js/views/track.js` |
| 8-second undo toast, haptics, no confirm dialogs | `run()` / `showToast()` in `js/app.js`; every action returns an `undo` (`js/actions.js`) |
| Zombie Timer Guard (nursing >45 min per side or >75 min total, day nap >3.5 h): one tap to stop at your personal average, or pick an end time | `anomaly()` in `js/logic/timers.js`, banner in `track.js`, `zombie` sheet |
| Bilateral nursing state machine, atomic side switch, Dessert Rule next side | `js/logic/timers.js` |
| FIFO milk stash, CDC/MOH expiry (room 4 h / fridge 96 h / freezer 6 mo / thawed 24 h, never refreeze) | `js/logic/stash.js`, `js/views/stash.js` |
| SweetSpot: `W_eff = ((1-α)·W_age + α·W_10d)·dayFactor − shortNapPenalty`; morning ×0.85, bedtime ×1.2; dual prediction at 4–5 months; alerts at T-20 and T-5 | `js/logic/sweetspot.js`, `sweetAlerts()` in `app.js` |
| Hydration check (≥6 wet diapers per 24 h after day 5), stool-colour red flags (acholic, red, black after day 5) | `js/logic/clinical.js` |
| Medication locks shared across devices: D3 and iron once a day; Novimol every 4 h (max 5 per 24 h, 15 mg/kg); Nurofen every 6 h (max 3, 10 mg/kg, blocked under 3 months); 2-hour gap between different drugs; fever red flag under 3 months | `js/logic/meds.js` |
| Tipat Halav / pediatrician report: 7- and 14-day averages, day/night sleep split, D3 and iron compliance, WHO LMS percentiles and curves, alert when 2 percentile bands are crossed, print and share | `js/views/report.js`, `js/logic/who.js`, `js/data/who-lms.js` |
| Distributed timers: rows sync only `status/started_at/accumulated_*`; each device renders with `requestAnimationFrame` | `js/logic/timers.js`, ticker in `app.js` |
| Offline outbox (`local_care_events`, `sync_outbox_queue`), idempotent `UPSERT … ON CONFLICT (client_mutation_id)`, drained on `online` / `visibilitychange`, exponential backoff, dead-letter after 6 failures | `js/idb.js`, `js/store.js`, `js/sync.js` |
| PWA manifest, offline service worker, URL quick actions (`?quick_action=nursing|wet_diaper|dirty_diaper|sleep|bottle|vitamin_d|pump`), Screen Wake Lock and auto-dim during nursing | `manifest.json`, `sw.js`, `app.js` |
| iOS Shortcuts / Action Button / Siri, using the `quick-log` Edge Function and an in-app guide | `supabase/functions/quick-log/index.ts`; Settings → "חיבור ל-iOS Shortcuts" |

The WHO data comes from the official WHO 2006 daily LMS tables (weight-, length- and head-circumference-for-age, boys and girls). It is sampled weekly from 0 to 735 days and interpolated linearly. The unit tests check that the medians match the reference values.

## Connect Supabase (sharing between two phones)

1. Create a project, then apply the schema:
   ```bash
   supabase link --project-ref <ref>
   supabase db push                      # applies supabase/migrations/20261117000000_init.sql
   supabase functions deploy quick-log --no-verify-jwt
   ```
   You can also paste the migration into the SQL editor.
2. In **Auth → URL configuration**, add your app's URL to the redirect allow-list. The app signs in with an email OTP or magic link, so there are no passwords.
3. Put the project URL and anon key in `js/config.js`, or paste them at runtime in **הגדרות → חיבור לענן**. Runtime values are stored only on that device.
4. Parent 1 signs in and taps **"יצירת משק בית חדש"**. The data already on the device, seeded or real, is uploaded through the outbox. Parent 2 signs in and enters the **6-character invite code**. They become `parent_admin`; anyone who joins after the second parent becomes `caregiver_log_only`. An admin can change roles, for example to `viewer_pediatrician` (read-only).

### Schema and security

- The seven requested tables, with check constraints, indexes and `UNIQUE (baby_id, timer_type)` on `active_timers`.
- RLS everywhere, through `is_member` / `can_log` / `is_admin` (security-definer helpers):
  - Viewers can only read.
  - `logged_by` must equal `auth.uid()`.
  - Child rows must belong to their baby's household (enforced by a trigger).
- Triggers:
  - Last-write-wins on `client_updated_at` / `updated_at`, so an offline phone replaying old mutations cannot overwrite newer data.
  - Thawed milk can never go back into the freezer.
- RPCs: `create_household`, `join_household`, `set_member_role` (always keeps at least one admin), `rotate_invite_code`.
- Realtime publication for all live tables. `active_timers` uses `replica identity full` so DELETE events carry the row's keys.

### iOS Shortcuts endpoint

```
POST https://<ref>.supabase.co/functions/v1/quick-log
{ "invite_code": "ABC123", "action_type": "wet_diaper", "parent_name": "הדס", "offset_minutes": 0 }
```

| Field | Values |
|---|---|
| `action_type` | `nursing` (start, switch with `side`, or stop) · `nursing_stop` · `sleep` (toggle) · `wet_diaper` · `dirty_diaper` · `mixed_diaper` · `bottle` (`volume_ml`, `source`; pumped milk is taken FIFO from the stash) · `pumping` (`volume_ml`, adds a fridge bag) · `vitamin_d` (refuses a second dose the same day) · `status` (a sentence for Siri to read aloud) |
| Response | `{ ok, message }`. `message` is Hebrew text, ready for "Show Result" or "Speak Text". |

> **Security note:** for convenience the invite code acts as the key. For more protection, set `households.shortcut_token` in the SQL editor. The function will then also require `"token": "<value>"` in the body. Rotate a leaked invite code with `select rotate_invite_code('<household_id>')`.

## Project layout

```
index.html  styles.css  manifest.json  sw.js  icons/
js/app.js            shell: render, events, rAF ticker, toasts, wake lock, alerts, quick actions
js/store.js          in-memory state → IndexedDB → transport
js/actions.js        domain actions, each returning { message, undo }
js/sync.js           LocalTransport (BroadcastChannel) | CloudTransport (Supabase outbox + realtime + presence)
js/idb.js  js/seed.js  js/util.js  js/config.js
js/logic/            timers · stash · sweetspot · meds · who · clinical   (pure, unit-tested)
js/views/            track · stash · journal · report · sheets · charts · icons · common
supabase/migrations/ schema + RLS + RPCs + realtime
supabase/functions/quick-log/   Edge Function (Deno)
tests/               logic.test.mjs (node:test) · rls.pglite.mjs (PGlite)
```

## Known limits

- SweetSpot notifications fire while the app is open or in the background with the page alive. Fully closed-app push would need Web Push (VAPID) and a scheduled Edge Function.
- iOS ignores `navigator.vibrate`. Haptics work on Android.
- Medication concentrations default to Novimol 160 mg/5 ml and Nurofen 100 mg/5 ml. **Check the bottle** and adjust in Settings.

> ⚕️ This app helps you keep records. It does not replace medical advice. When in doubt, contact your pediatrician, the Ministry of Health hotline at \*5400, or Magen David Adom at 101.
