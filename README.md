# VCASO Fitness

Daily training for a racing driver: running and calisthenics anywhere, periodised around the FIA F3 2027 season, with Oura readiness, Garmin verification (via Strava), barcode food logging and a weekly score out of 100.

- **Front end:** static site in this repo (GitHub Pages). Installable on iPhone and iPad from Safari: Share → Add to Home Screen.
- **Data and logins:** the `vcaso-performance` Supabase project, same logins as Rodin Hub and Brake Trainer. Tables are prefixed `fx_`; a driver reads and writes only their own rows. Wearable tokens are server-only.
- **Offline:** everything saves on the device first and syncs when there's signal. With no account, or no network, it runs on a local profile.

## Files

| | |
|---|---|
| `js/engine.js` | Calendar, phases, daily sessions, the illness guard, verification, nutrition targets, weekly score. No DOM; tested by `node test/engine.test.cjs`. |
| `js/app.js` | Screens: Today, Plan, Fuel, Recover, Score, Settings, the session player. |
| `js/drills.js` | Reaction drills: lights out, go/no-go, peripheral targets. |
| `supabase/functions/fx-sync` | Oura and Strava OAuth, token refresh, data pull. |
| `supabase/functions/fx-remind` | Morning call: pg_cron every 5 min, per-driver local time. |

## The rules

- **Week:** Calisthenics A (upper + grip) · Intervals · Easy run + core · Calisthenics B (legs + brake leg) · Tempo · Long run · Recovery calisthenics. Every fourth week is lighter. Race weeks taper; Thursday is a hotel session; Friday–Sunday is a 15-minute activation.
- **Illness guard:** red (readiness < 55, sleep < 55, temp +0.5 °C, resting HR +7, or reported ill) swaps the session for recovery and it still counts. Amber (55–69, resting HR +4, flat or very sore) trims it; the driver can override.
- **Moves:** two a week, never on Sunday. Sessions slide a day; the last one drops. A moved session scores 85%.
- **Score /100:** training 40 (Garmin-verified 100%, self-reported 70%) · nutrition 25 · sleep + water 15 · check-in + weigh-in 10 · reactions 10 (Brake Trainer runs count).

## Switching on Oura and Garmin

Edge-function secrets in Supabase: `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`.

- Oura app (cloud.ouraring.com → OAuth applications), redirect URI `https://bqvygaqvwmakbrxnllws.supabase.co/functions/v1/fx-sync/oura`
- Strava app (strava.com/settings/api), Authorization Callback Domain `bqvygaqvwmakbrxnllws.supabase.co`
- Garmin Connect → Connected Apps → Strava, so every Garmin activity lands in Strava automatically.
