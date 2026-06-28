# World Cup Draw 2026

A shared, no-login page for our 6-player World Cup draw. Shows each player's
combined chance of "owning the winner" (sticky standings) and a knockout bracket
with per-match win % — driven by real bookmaker-implied probabilities.

## How it works

- **Site**: static `index.html` + `assets/`. Reads `data/state.json`.
- **Odds**: `scripts/fetch_odds.py` pulls from [The Odds API](https://the-odds-api.com/)
  (outright winner + match h2h), removes the bookmaker margin, normalizes to 100%,
  and writes `data/state.json`.
- **Automation**: `.github/workflows/update-odds.yml` runs the scraper 3×/day and
  commits the refreshed data. GitHub Pages then redeploys automatically.

## One-time setup

1. **API key** — sign up free at https://the-odds-api.com/, then in this repo:
   *Settings → Secrets and variables → Actions → New repository secret*
   - Name: `ODDS_API_KEY`  Value: *(your key)*
2. **Pages** — *Settings → Pages → Build and deployment → Deploy from a branch →
   `main` / `root`*. Site goes live at `https://fbkevy.github.io/WorldCup2026/`.
3. **First data pull** — *Actions → Update odds → Run workflow* (manual trigger).

## Local preview

```
python -m http.server 8765      # then open http://localhost:8765
python scripts/build_sample.py  # regenerate placeholder data
ODDS_API_KEY=xxxx python scripts/fetch_odds.py   # pull real odds locally
```

## Data model (`data/state.json`)

- `players[]` — id, name, colour, owned teams
- `teams{}` — owner, `winProb` (tournament-win), `alive`
- `bracket{}` — R32/R16/QF/SF/F; each match has teamA/teamB, probA/probB, winner

As the tournament progresses, fill in bracket `teamA`/`teamB` and set `winner`
("A"/"B") on completed matches; the scraper fills probabilities for matchups
that are set.
