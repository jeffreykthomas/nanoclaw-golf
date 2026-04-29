---
name: arccos-golf
description: Fetch Arccos golf data via the internal Arccos REST API (with a one-time browser auth bootstrap). Use when the user asks about their golf stats, progress, performance, handicap, rounds, or Arccos data.
allowed-tools: Bash(agent-browser:*), Bash(curl:*), Bash(jq:*), Bash(python3:*)
---

# Arccos Golf — API-first client

This skill talks to `https://api.arccosgolf.com/` directly using a stable per-user `accessKey`. Browser automation is only used **once** (or when the key expires) to log in and read that key out of the dashboard's cookies.

Two modes:

- **Sync Mode** — batch extraction emitting a strict JSON payload. Triggered when the prompt contains `ARCCOS_SYNC_MODE=1`.
- **Interactive Mode** — ad-hoc questions, markdown answers. Anything else.

## Credentials (env)

`ARCCOS_EMAIL` and `ARCCOS_PASSWORD` are passed into the container. They are only needed if we have to log in (no cached creds). Verify:

```bash
[ -n "$ARCCOS_EMAIL" ] && echo "creds found" || echo "ERROR: ARCCOS_EMAIL not set"
```

If missing in Sync Mode → emit the failure JSON (`missing_credentials`) and exit.

## Auth bootstrap (browser, one-time)

The Arccos dashboard stores a JSON blob in a cookie named `creds` containing `{accessKey, token, user:{userId}}`. We log in once with the browser, read that cookie, and cache it.

Cached creds live at `/workspace/group/arccos-creds.json`:

```json
{ "access_key": "<40-char hex>", "user_id": "<uuid-ish>", "fetched_at": "<iso ts>" }
```

### Decide whether to bootstrap

```bash
CREDS=/workspace/group/arccos-creds.json
if [ -f "$CREDS" ]; then
  ACCESS_KEY=$(jq -r .access_key "$CREDS")
  USER_ID=$(jq -r .user_id "$CREDS")
  # Probe one endpoint — if 200, skip bootstrap
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    "https://api.arccosgolf.com/users/$USER_ID/rounds?limit=1" \
    -H "Authorization: $ACCESS_KEY")
  echo "cached creds probe: HTTP $STATUS"
fi
```

If `STATUS` is 200 → **skip to Data Fetch**. Otherwise (no file, or 401/403) → run the browser bootstrap below.

### Browser bootstrap

```bash
agent-browser state load /workspace/group/arccos-auth.json 2>/dev/null
agent-browser open https://dashboard.arccosgolf.com/
agent-browser wait --load networkidle
agent-browser get url
```

If the URL still has `/login`, do login:

```bash
agent-browser snapshot -i
# Look for email, password, submit refs
agent-browser fill @<email_ref> "$ARCCOS_EMAIL"
agent-browser fill @<password_ref> "$ARCCOS_PASSWORD"
agent-browser click @<submit_ref>
agent-browser wait --load networkidle
```

Handle common login variants: "Sign in with email" toggles, cookie/terms banners, 2FA (report failure if encountered in Sync Mode).

Save the browser state for future runs:

```bash
agent-browser state save /workspace/group/arccos-auth.json
```

### Extract `creds` from cookies

The state file is JSON with a `cookies` array. The `creds` cookie value is a URL-encoded JSON blob.

```bash
python3 - <<'PY'
import json, urllib.parse, datetime, pathlib
state = json.load(open("/workspace/group/arccos-auth.json"))
creds_cookie = next((c for c in state.get("cookies", []) if c["name"] == "creds"), None)
if not creds_cookie:
    raise SystemExit("no_creds_cookie")
raw = urllib.parse.unquote(creds_cookie["value"])
data = json.loads(raw)
out = {
    "access_key": data["accessKey"],
    "user_id": data["user"]["userId"],
    "fetched_at": datetime.datetime.utcnow().isoformat() + "Z",
}
pathlib.Path("/workspace/group/arccos-creds.json").write_text(json.dumps(out, indent=2))
print("saved:", out["user_id"])
PY
```

Re-read `ACCESS_KEY` and `USER_ID` from the file.

**Keep the browser open** if this is Sync Mode — we'll use it again for the SG scrape in Phase B. If we hit the cached-creds fast path and skipped the browser entirely, open it now so Phase B can use it:

```bash
# Only if we skipped browser bootstrap but are in Sync Mode:
# agent-browser state load /workspace/group/arccos-auth.json 2>/dev/null
# agent-browser open https://dashboard.arccosgolf.com/
# agent-browser wait --load networkidle
```

---

# Sync Mode (JSON output)

Activated when the prompt contains `ARCCOS_SYNC_MODE=1`. Prompt also provides:

- `ARCCOS_CUTOFF_DATE=YYYY-MM-DD` — skip rounds played before this date
- `ARCCOS_KNOWN_EXTERNAL_IDS=<csv>` — `roundId`s already in Rails; skip them
- `ARCCOS_MAX_ROUNDS=<N>` — safety cap

## Procedure

1. Ensure auth (see above). On failure → emit failure JSON and exit.

2. **Fetch all rounds metadata:**

   ```bash
   curl -s "https://api.arccosgolf.com/users/$USER_ID/rounds" \
     -H "Authorization: $ACCESS_KEY" > /workspace/group/rounds-list.json
   ```

   The response is `{ "rounds": [ { roundId, courseId, startTime, noOfHoles, ... } ] }`.

3. **Filter client-side** by cutoff date and known IDs, respecting `ARCCOS_MAX_ROUNDS`. Keep the full set sorted by `startTime` ascending so Rails upserts in chronological order.

4. **Fetch each new round's detail** (includes hole-by-hole shots, putts, fairways, GIR, up-downs, distances):

   ```bash
   curl -s "https://api.arccosgolf.com/users/$USER_ID/rounds/$ROUND_ID" \
     -H "Authorization: $ACCESS_KEY" > "/workspace/group/arccos-round-details/$ROUND_ID.json"
   ```

   Loop in parallel (e.g. `xargs -P 4`) — the API is fast. ~200ms per round.

5. **Fetch each unique `courseId`** once for the course name + par:

   ```bash
   curl -s "https://api.arccosgolf.com/courses/$COURSE_ID" \
     -H "Authorization: $ACCESS_KEY" > "/workspace/group/arccos-courses/$COURSE_ID.json"
   ```

6. **Compute per-round stats** from the hole array. Each hole object includes `putts`, `isGir` (T/F), `isFairWay`/`isFairWayUser`, `isUpDownChance`/`isUpDown`, `noOfShots`, and a `shots` array with distances, lies, etc. Derive:

   ```
   putts          = sum(hole.putts)
   putts_breakdown = count of holes by putts (1/2/3+)
   greens_in_regulation / gir_attempted
   fairways_hit / fairways_attempted  (only par-4/5s; use isFairWay OR isFairWayUser when present)
   up_downs / up_downs_attempted      (only where isUpDownChance == "T")
   total_score    = sum(hole.noOfShots)  (or round.noOfShots)
   holes_played   = round.noOfHoles
   total_par      = sum of pars from course holes for those played holes
   avg_drive_yards / longest_drive_yards — from par-4/5 tee shots' distance field
   avg_approach_distance_yards — average starting distance of "approach" shots
   actual_yardage — sum of hole distances played
   ```

   Use a single Python script that reads all the detail files and emits the final JSON. Keep it in one tool call so we don't spend turns.

7. **Aggregate profile**: derive `handicap_index`/`scoring_average`/`rounds_tracked` from the rounds list if present, OR leave them omitted (Rails keeps prior values).

8. **Phase B — Strokes Gained scrape from the Rounds list page.**

   SG isn't exposed by the public API, but the dashboard's Rounds list shows the four SG numbers (driving / approach / short / putting) on every row. We can scrape them quickly while the browser session is already authenticated.

   a. Navigate to the Rounds list (observe the URL the dashboard uses after login — typically `https://dashboard.arccosgolf.com/rounds` or similar). Wait for network idle.

   b. For each page (10 rounds per page), take a structured snapshot and extract, for every row:
      - The round detail link (its href contains the `roundId`, e.g. `/rounds/27138960/stats/overall`) → this is your join key.
      - The four SG values with their labels: **Driving**, **Approach**, **Short**, **Putting** (signs matter — they can be negative).

      ```bash
      agent-browser snapshot -c > /workspace/group/rounds-page-$PAGE.txt
      # Then parse the snapshot to pull roundId + the four SG values per row.
      ```

   c. **Stop pagination** as soon as you see a round older than `ARCCOS_CUTOFF_DATE`, or when you've collected SG for every round in your Phase-A set. Typical budget for 6 months: 4–6 pages.

   d. Merge the SG values into the per-round output by `roundId` (string match). For each round, add:
      - `sg_off_tee`, `sg_approach`, `sg_short_game`, `sg_putting`
      - Compute `sg_total = sg_off_tee + sg_approach + sg_short_game + sg_putting` (rounded to 1 decimal)

   e. **If SG scraping fails** for any reason (page structure changed, selectors won't resolve, paywall) — do **not** fail the whole sync. Skip Phase B, set `status: "partial"`, add `"sg_scrape_failed"` to `meta.warnings`, and emit the API-derived data anyway.

9. **Close the browser** and **emit the final JSON** (see schema below).

   ```bash
   agent-browser close 2>/dev/null || true
   ```

## Strict JSON output

Your final message must be exactly one fenced JSON block:

````
```json
{
  "status": "ok",
  "profile": {
    "handicap_index": 4.0,
    "rounds_tracked": 155,
    "aggregate_strokes_gained": {}
  },
  "rounds": [
    {
      "external_id": "27138960",
      "played_on": "2026-04-18",
      "course_name": "The Farms GC",
      "holes_played": 18,
      "total_score": 88,
      "total_par": 72,
      "putts": 39,
      "greens_in_regulation": 8,
      "fairways_hit": 7,
      "fairways_attempted": 14,
      "raw_payload": {
        "round_id": 27138960,
        "course_id": 1522,
        "putts_breakdown": { "one_putts": 2, "two_putts": 11, "three_putts": 5 },
        "gir_attempted": 18,
        "up_downs": 1,
        "up_downs_attempted": 10,
        "avg_drive_yards": 269,
        "longest_drive_yards": 283,
        "avg_approach_distance_yards": 150,
        "actual_yardage": 6878,
        "source": "api+sg_scrape"
      },
      "sg_off_tee": 0.3,
      "sg_approach": -0.1,
      "sg_short_game": -1.1,
      "sg_putting": -1.6,
      "sg_total": -2.5
    }
  ],
  "meta": {
    "cutoff_date": "2025-10-20",
    "rounds_total": 155,
    "rounds_in_window": 42,
    "rounds_skipped_known": 12,
    "rounds_fetched": 30,
    "source": "api+sg_scrape",
    "sg_rounds_matched": 40,
    "warnings": []
  }
}
```
````

### Field rules

- **Any missing numeric field** → omit the key (do NOT emit `null` or `0`).
- **`external_id`** must be the string form of Arccos's `roundId`.
- **Strokes gained** (`sg_*`) comes from the Phase-B browser scrape. Omit the keys entirely if Phase B was skipped or the round wasn't matched.
- Rounds array must be **chronological (oldest first)**.
- `status = "ok"` when API + SG both succeeded for all rounds. `"partial"` when API worked but SG did not (or only matched some rounds). `"error"` when API itself failed.

### Failure output

```json
{ "status": "error", "error": "<short_code>", "message": "<human>", "rounds": [], "meta": { "warnings": [] } }
```

Codes: `missing_credentials`, `auth_failed`, `api_unreachable`, `parse_failed`, `unknown`.

---

# Interactive Mode (default)

Used for ad-hoc questions. Same auth bootstrap, same API. Reply in markdown, not JSON.

Examples:

- *"How's my putting been lately?"* → `GET /users/$USER_ID/rounds?limit=10`, per-round detail, derive putts/round and 3-putt rate, summarize in a short table.
- *"What's my scoring average at The Farms?"* → filter rounds list by course, show count + avg.

Keep it concise; don't over-call the API.

# Troubleshooting

- **401 from API after bootstrap** → access key revoked. Delete `arccos-creds.json` and re-run bootstrap.
- **2FA / CAPTCHA at login** → Sync Mode: `status: "error"`, `error: "auth_failed"`. Interactive Mode: tell the user.
- **`creds` cookie missing after login** → login probably didn't complete. Snapshot the page and investigate what screen we're on (email verification? T&C banner?).

# Cleanup

```bash
agent-browser close 2>/dev/null || true
```
