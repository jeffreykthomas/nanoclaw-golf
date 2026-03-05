---
name: arccos-golf
description: Scrape golf performance data from the Arccos Golf dashboard — rounds played, putting, short game, approach, and driving stats. Use when the user asks about their golf stats, progress, performance, handicap, rounds, or Arccos data.
allowed-tools: Bash(agent-browser:*)
---

# Arccos Golf Dashboard Scraper

Fetches golf performance data from https://dashboard.arccosgolf.com/ using browser automation.

## Credentials

Arccos credentials are passed as container env vars `ARCCOS_EMAIL` and `ARCCOS_PASSWORD`. Verify they exist before proceeding:

```bash
[ -n "$ARCCOS_EMAIL" ] && echo "Credentials found" || echo "ERROR: ARCCOS_EMAIL not set"
```

If missing, tell the user to add `ARCCOS_EMAIL` and `ARCCOS_PASSWORD` to their NanoClaw `.env` file and restart.

## Authentication

### Load saved session (skip login if valid)

```bash
agent-browser state load /workspace/group/arccos-auth.json 2>/dev/null
agent-browser open https://dashboard.arccosgolf.com/
agent-browser wait --load networkidle
agent-browser get url
```

If the URL contains `/login` or `/sign-in`, the saved session is stale — proceed to login. Otherwise skip to **Data Extraction**.

### Login flow

```bash
agent-browser open https://dashboard.arccosgolf.com/
agent-browser wait --load networkidle
agent-browser snapshot -i
```

Look for email/username and password fields plus a sign-in button. Fill and submit:

```bash
agent-browser fill @<email_ref> "$ARCCOS_EMAIL"
agent-browser fill @<password_ref> "$ARCCOS_PASSWORD"
agent-browser click @<submit_ref>
agent-browser wait --load networkidle
```

Handle common login variants:
- If there's a "Sign in with email" or similar toggle, click it first
- If there's a cookie/terms banner, dismiss it before filling fields
- If login fails (error message visible), report the error to the user

After successful login, save the session:

```bash
agent-browser state save /workspace/group/arccos-auth.json
```

## Data Extraction

After authentication, the dashboard typically shows an overview. Navigate to extract these categories:

### 1. Rounds

Look for a "Rounds" or "Activity" section. Extract:
- Recent round dates, courses, and scores
- Scoring average and trend
- Number of rounds played

```bash
agent-browser snapshot -i
# Navigate to rounds section if not already visible
# Use click on relevant nav element
agent-browser snapshot -c
```

Use `agent-browser get text @<ref>` to extract specific data points. If rounds are in a list/table, iterate through visible entries.

### 2. Strokes Gained / Performance Stats

Navigate to the stats or "Strokes Gained" section. Arccos breaks performance into four categories:

**Putting**
- Strokes gained putting
- Putts per round
- 3-putt avoidance
- Make percentage by distance

**Short Game** (within ~100 yards)
- Strokes gained around the green
- Up-and-down percentage
- Scrambling percentage
- Proximity to hole from various distances

**Approach** (100+ yards into the green)
- Strokes gained approach
- Greens in regulation (GIR) percentage
- Proximity to hole by club/distance

**Driving** (tee shots)
- Strokes gained off the tee
- Driving accuracy (fairways hit %)
- Driving distance average

For each category:
```bash
# Navigate to the category tab/section
agent-browser snapshot -i
agent-browser click @<category_tab_ref>
agent-browser wait --load networkidle
agent-browser snapshot -c
# Extract key metrics
agent-browser get text @<metric_ref>
```

### 3. Handicap / Smart Distance

If visible on the dashboard, also capture:
- Current handicap index
- Smart Distance club averages

## Output Format

Compile the extracted data into a structured summary:

```
## Golf Progress (Arccos)

### Overview
- Handicap: X.X
- Rounds tracked: N (last 30/90 days)
- Scoring average: X.X

### Strokes Gained Breakdown
| Category    | Strokes Gained | Key Metric          |
|-------------|---------------|---------------------|
| Driving     | +/-X.X        | Accuracy: X%        |
| Approach    | +/-X.X        | GIR: X%             |
| Short Game  | +/-X.X        | Scrambling: X%      |
| Putting     | +/-X.X        | Putts/round: X.X    |

### Recent Rounds
| Date       | Course        | Score | vs Par |
|------------|---------------|-------|--------|
| ...        | ...           | ...   | ...    |
```

## Troubleshooting

- **Page loads blank / spinner**: Wait longer with `agent-browser wait 5000`, then re-snapshot
- **"Upgrade" paywall**: Some Arccos stats require a premium subscription. Report which data is locked
- **2FA / CAPTCHA**: Report to user — cannot automate these; they'll need to login manually once and the saved state should persist
- **Session expired mid-scrape**: Re-run the login flow and save a fresh state file

## Cleanup

Always close the browser when done:

```bash
agent-browser close
```
