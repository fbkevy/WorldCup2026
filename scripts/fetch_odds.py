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

SPORT = "soccer_fifa_world_cup"
BASE = "https://api.the-odds-api.com/v4"
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
    data = api_get(f"/sports/{SPORT}/odds", {
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
    """Returns {frozenset({teamA,teamB}): {teamA: probA, teamB: probB}}."""
    data = api_get(f"/sports/{SPORT}/odds", {
        "regions": regions, "markets": "h2h", "oddsFormat": "decimal",
    })
    out = {}
    for event in data:
        home, away = canon(event.get("home_team")), canon(event.get("away_team"))
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
        out[frozenset({home, away})] = {home: round(h / s, 3), away: round(a / s, 3)}
    return out


def main():
    if not os.environ.get("ODDS_API_KEY"):
        print("ERROR: ODDS_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    regions = os.environ.get("ODDS_REGIONS", "uk,eu")

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
                probs = h2h[key]
                m["probA"] = probs.get(canon(a))
                m["probB"] = probs.get(canon(b))
                matched += 1
    print(f"Updated h2h for {matched} live matches", file=sys.stderr)

    # Keep eliminations + bracket advancement consistent on every refresh.
    wc_lib.advance(state)

    state["source"] = "the-odds-api"
    state["updatedAt"] = (datetime.datetime.now(datetime.timezone.utc)
                          .replace(microsecond=0).isoformat())
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                          encoding="utf-8")
    print("Wrote", STATE_PATH, file=sys.stderr)


if __name__ == "__main__":
    main()
