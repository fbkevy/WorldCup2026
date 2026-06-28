"""
Fetches real World Cup odds from The Odds API and merges them into
data/state.json (preserving player allocation and bracket structure).

What it updates:
  * teams[].winProb  -> from the OUTRIGHT WINNER market (vig removed, sums to 1)
  * bracket match probA/probB -> from H2H match odds, but ONLY for matches whose
    two teams are already set (head-to-head known), matched by team name.

What it does NOT do automatically (kept in data/state.json, edited as the
tournament progresses): which teams advance into each bracket slot, and group
-stage eliminations. Knockout losers are marked eliminated from match `winner`.

Env:
  ODDS_API_KEY   required (free key from https://the-odds-api.com/)
  ODDS_REGIONS   optional, default "uk,eu"

Run:  ODDS_API_KEY=xxxx python scripts/fetch_odds.py
"""
import json
import os
import sys
import datetime
import pathlib
import urllib.request
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wc_lib

SPORT = "soccer_fifa_world_cup"            # individual match (h2h) odds
WINNER_SPORT = "soccer_fifa_world_cup_winner"  # outright tournament winner (separate key!)
BASE = "https://api.the-odds-api.com/v4"

# Scheduling: the workflow ticks every 30 min, but we only spend API credits at
# the 3x/day baseline and once ~30 min after each game finishes.
BASELINE_HOURS = (7, 13, 19)          # UTC hours for the 3x/day refresh
POST_GAME_DELAY_MIN = 150             # minutes after kickoff ≈ 30 min post full-time
                                      # (covers half-time + stoppage; raise toward
                                      # ~180 if you want to clear extra-time games)
ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / "data" / "state.json"

# The Odds API team names -> our names. Add entries if a team is missing.
NAME_MAP = {
    "South Korea": "Korea Republic",
    "Turkey": "Türkiye",
    "United States": "USA",
    "USA": "USA",
    "Czech Republic": "Czechia",
    "Ivory Coast": "Ivory Coast",
    "Cote d'Ivoire": "Ivory Coast",
    "DR Congo": "DR Congo",
    "Congo DR": "DR Congo",
    "Cape Verde": "Cape Verde",
    "Cabo Verde": "Cape Verde",
    "Bosnia & Herzegovina": "Bosnia",
    "Bosnia and Herzegovina": "Bosnia",
}


def canon(name):
    name = (name or "").strip()
    return NAME_MAP.get(name, name)


def api_get(path, params):
    params = {**params, "apiKey": os.environ["ODDS_API_KEY"]}
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        remaining = r.headers.get("x-requests-remaining")
        if remaining is not None:
            print(f"  credits remaining: {remaining}", file=sys.stderr)
        return json.load(r)


def implied_no_vig(price_by_name):
    """decimal odds -> normalized implied probabilities (sum to 1)."""
    raw = {n: 1.0 / p for n, p in price_by_name.items() if p and p > 0}
    total = sum(raw.values())
    if total <= 0:
        return {}
    return {n: v / total for n, v in raw.items()}


def fetch_outrights(regions):
    data = api_get(f"/sports/{WINNER_SPORT}/odds", {
        "regions": regions, "markets": "outrights", "oddsFormat": "decimal",
    })
    # Average each team's implied prob across bookmakers, then renormalize.
    sums, counts = {}, {}
    for event in data:
        for bm in event.get("bookmakers", []):
            for mk in bm.get("markets", []):
                if mk.get("key") != "outrights":
                    continue
                prices = {canon(o["name"]): o["price"] for o in mk["outcomes"]}
                for name, p in implied_no_vig(prices).items():
                    sums[name] = sums.get(name, 0) + p
                    counts[name] = counts.get(name, 0) + 1
    avg = {n: sums[n] / counts[n] for n in sums}
    total = sum(avg.values())
    return {n: v / total for n, v in avg.items()} if total else {}


def fetch_match_h2h(regions):
    """Returns {frozenset({teamA,teamB}): {"probs": {team: p}, "kickoff": iso}}."""
    data = api_get(f"/sports/{SPORT}/odds", {
        "regions": regions, "markets": "h2h", "oddsFormat": "decimal",
    })
    out = {}
    for event in data:
        home, away = canon(event.get("home_team")), canon(event.get("away_team"))
        commence = event.get("commence_time")  # ISO 8601 UTC from the API
        if not home or not away:
            continue
        prices = {}
        n = 0
        for bm in event.get("bookmakers", []):
            for mk in bm.get("markets", []):
                if mk.get("key") != "h2h":
                    continue
                book = {canon(o["name"]): o["price"] for o in mk["outcomes"]}
                imp = implied_no_vig(book)  # includes Draw for soccer 1X2
                for k, v in imp.items():
                    prices[k] = prices.get(k, 0) + v
                n += 1
        if not n or home not in prices or away not in prices:
            continue
        # Drop the draw and renormalize to "who wins the tie".
        h, a = prices[home] / n, prices[away] / n
        s = h + a
        if s <= 0:
            continue
        out[frozenset({home, away})] = {
            "probs": {home: round(h / s, 3), away: round(a / s, 3)},
            "kickoff": commence,
        }
    return out


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def should_fetch(state, now):
    """Decide whether to spend API credits this tick.

    Returns (do_fetch: bool, reasons: list[str], due_match_ids: list[str]).
    Fetch when: forced, OR within a 3x/day baseline window, OR a game finished
    ~30 min ago that we haven't refreshed for yet (tracked in state.postFetched).
    """
    reasons = []
    if os.environ.get("FORCE_FETCH") or "--force" in sys.argv:
        return True, ["forced"], []

    if now.hour in BASELINE_HOURS and now.minute < 30:
        reasons.append("baseline")

    done = set(state.get("postFetched", []))
    due = []
    for rnd in state["bracket"].values():
        for m in rnd:
            ko = parse_iso(m.get("kickoff"))
            if ko and m["id"] not in done:
                age_min = (now - ko).total_seconds() / 60
                if age_min >= POST_GAME_DELAY_MIN:
                    due.append(m["id"])
    if due:
        reasons.append(f"post-game({len(due)})")

    return bool(reasons), reasons, due


def main():
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)

    do_fetch, reasons, due = should_fetch(state, now)
    if not do_fetch:
        print("Nothing due — skipping API call (no credits spent).", file=sys.stderr)
        return
    print("Fetching. Reasons:", ", ".join(reasons), file=sys.stderr)

    if not os.environ.get("ODDS_API_KEY"):
        print("ERROR: ODDS_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    # Single region by default to conserve the free 500 credits/month; override
    # with ODDS_REGIONS (e.g. "uk,eu") if you have headroom.
    regions = os.environ.get("ODDS_REGIONS", "uk")

    # 1) Outright winner -> tournament-win probability per team
    win = fetch_outrights(regions)
    updated = 0
    for team, info in state["teams"].items():
        if team in win and info.get("alive", True):
            info["winProb"] = round(win[team], 5)
            updated += 1
    print(f"Updated winProb for {updated} teams", file=sys.stderr)

    # Diagnostic: flag still-alive teams that got NO odds (likely a name
    # mismatch -> add them to NAME_MAP). Helps debug the first live run.
    missing = sorted(t for t, i in state["teams"].items()
                     if i.get("alive", True) and t not in win)
    if missing:
        print("WARNING: no odds matched for alive teams (check NAME_MAP): "
              + ", ".join(missing), file=sys.stderr)
    extra = sorted(set(win) - set(state["teams"]))
    if extra:
        print("NOTE: API returned teams not in our list: "
              + ", ".join(extra), file=sys.stderr)

    # 2) H2H -> probabilities for bracket matches whose teams are both set
    h2h = fetch_match_h2h(regions)
    matched = 0
    for rnd in state["bracket"].values():
        for m in rnd:
            a, b = m.get("teamA"), m.get("teamB")
            if not (a and b) or m.get("winner") is not None:
                continue
            key = frozenset({canon(a), canon(b)})
            if key in h2h:
                probs = h2h[key]["probs"]
                m["probA"] = probs.get(canon(a))
                m["probB"] = probs.get(canon(b))
                if h2h[key].get("kickoff"):
                    m["kickoff"] = h2h[key]["kickoff"]
                matched += 1
    print(f"Updated h2h for {matched} live matches", file=sys.stderr)

    # Keep eliminations + bracket advancement consistent on every refresh.
    wc_lib.advance(state)

    # Record one-shot post-game fetches so each finished game is only refreshed
    # once (robust to GitHub's cron jitter / double ticks).
    if due:
        state["postFetched"] = sorted(set(state.get("postFetched", [])) | set(due))

    state["source"] = "the-odds-api"
    state["updatedAt"] = now.isoformat()
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                          encoding="utf-8")
    print("Wrote", STATE_PATH, file=sys.stderr)


if __name__ == "__main__":
    main()
