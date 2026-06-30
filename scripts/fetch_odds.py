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

# Scheduling: the workflow ticks every 30 min. We only spend API credits when a
# game is plausibly finishing (poll scores to get the real result — robust to
# extra time / penalties via the API's `completed` flag) and at a 3x/day odds
# baseline. Outside those windows the tick exits without any API call.
BASELINE_HOURS = (7, 13, 19)          # UTC hours for the 3x/day odds refresh
SCORE_CHECK_MIN = 95                  # start polling a game's result this many
                                      # minutes after kickoff (regular full time);
                                      # keeps polling every run until resolved, so
                                      # both normal-time and penalty finishes catch.
SCORE_CHECK_MAX = 300                 # stop polling after this (ET + pens + lag)
ODDS_THROTTLE_MIN = 15                # min minutes between live odds refreshes
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


def fetch_scores():
    """Recently completed + live games (daysFrom=3). Costs 2 credits."""
    return api_get(f"/sports/{SPORT}/scores", {"daysFrom": 3})


def apply_scores(state, events):
    """Set winner + score on any undecided bracket match that has finished.

    Uses the API `completed` flag, so extra time / penalties are handled (the
    game just shows as completed). A completed *level* score means a shootout we
    can't read from the score line — left for manual entry.
    Returns the list of match ids newly decided.
    """
    finished = {}
    for e in events:
        if not e.get("completed"):
            continue
        sc = {canon(s["name"]): s.get("score") for s in (e.get("scores") or [])}
        if len(sc) == 2:
            finished[frozenset(sc)] = sc

    newly, level = [], []
    for rnd in state["bracket"].values():
        for m in rnd:
            a, b = m.get("teamA"), m.get("teamB")
            if not (a and b) or m.get("winner") is not None:
                continue
            sc = finished.get(frozenset({canon(a), canon(b)}))
            if not sc:
                continue
            try:
                sa, sb = int(sc[canon(a)]), int(sc[canon(b)])
            except (TypeError, ValueError, KeyError):
                continue
            m["score"] = f"{sa}–{sb}"
            if sa != sb:
                m["winner"] = "A" if sa > sb else "B"
                newly.append(m["id"])
                print(f"Result: {a} {sa}-{sb} {b} -> {m['winner']}", file=sys.stderr)
            else:
                # Level after normal/extra time -> decided on penalties. The
                # score line can't tell us who won; resolve via the outright
                # market (the loser drops out) back in main().
                level.append(m)
                print(f"Penalty shootout: {a} v {b} {sa}-{sb} — resolving via market",
                      file=sys.stderr)
    return newly, level


def resolve_penalties(level_matches, alive_set):
    """Decide shootout winners from the outright market: the team still listed
    (alive_set) advanced, the absent one is out. Returns ids newly decided."""
    decided = []
    for m in level_matches:
        a_in = canon(m["teamA"]) in alive_set
        b_in = canon(m["teamB"]) in alive_set
        if a_in != b_in:                      # exactly one still in the market
            m["winner"] = "A" if a_in else "B"
            m["score"] = (m.get("score") or "") + " p"
            decided.append(m["id"])
            won = m["teamA"] if a_in else m["teamB"]
            print(f"Shootout result: {won} advances (pens)", file=sys.stderr)
        else:
            print(f"Shootout for {m['teamA']} v {m['teamB']} not resolvable yet "
                  f"(market not updated) — will retry", file=sys.stderr)
    return decided


def games_finishing(state, now):
    """Ids of undecided, known matches currently in their result-polling window."""
    ids = []
    for rnd in state["bracket"].values():
        for m in rnd:
            if m.get("teamA") and m.get("teamB") and m.get("winner") is None:
                ko = parse_iso(m.get("kickoff"))
                if ko:
                    age = (now - ko).total_seconds() / 60
                    if SCORE_CHECK_MIN <= age <= SCORE_CHECK_MAX:
                        ids.append(m["id"])
    return ids


def fetch_and_apply_odds(state, regions):
    """Refresh outright + h2h probabilities into state (in place)."""
    win = fetch_outrights(regions)
    updated = 0
    for team, info in state["teams"].items():
        if team in win and info.get("alive", True):
            info["winProb"] = round(win[team], 5)
            updated += 1
    print(f"Updated winProb for {updated} teams", file=sys.stderr)
    missing = sorted(t for t, i in state["teams"].items()
                     if i.get("alive", True) and t not in win)
    if missing:
        print("WARNING: no odds matched for alive teams (check NAME_MAP): "
              + ", ".join(missing), file=sys.stderr)

    h2h = fetch_match_h2h(regions)
    matched = 0
    for rnd in state["bracket"].values():
        for m in rnd:
            a, b = m.get("teamA"), m.get("teamB")
            if not (a and b) or m.get("winner") is not None:
                continue
            entry = h2h.get(frozenset({canon(a), canon(b)}))
            if entry:
                m["probA"] = entry["probs"].get(canon(a))
                m["probB"] = entry["probs"].get(canon(b))
                if entry.get("kickoff"):
                    m["kickoff"] = entry["kickoff"]
                matched += 1
    print(f"Updated h2h for {matched} live matches", file=sys.stderr)


HISTORY_PATH = ROOT / "data" / "history.json"


def append_history(state):
    """Append this update's player win-probabilities to data/history.json."""
    probs = {p["id"]: round(sum(state["teams"][t]["winProb"]
                                for t in p["teams"] if state["teams"][t].get("alive")), 5)
             for p in state["players"]}
    try:
        hist = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        hist = {"snapshots": []}
    snaps = hist.get("snapshots", [])
    if snaps and snaps[-1].get("t") == state["updatedAt"]:
        return
    snaps.append({"t": state["updatedAt"], "probs": probs})
    hist["snapshots"] = snaps[-800:]
    HISTORY_PATH.write_text(json.dumps(hist, ensure_ascii=False), encoding="utf-8")


def compute_ranks(state):
    """Player id -> 1-based rank by combined win prob of alive teams."""
    sums = {p["id"]: sum(state["teams"][t]["winProb"]
                         for t in p["teams"] if state["teams"][t].get("alive"))
            for p in state["players"]}
    order = sorted(state["players"], key=lambda p: -sums[p["id"]])
    return {p["id"]: i + 1 for i, p in enumerate(order)}


def main():
    state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
    ranks_before = compute_ranks(state)   # snapshot for rank-change arrows
    forced = bool(os.environ.get("FORCE_FETCH")) or "--force" in sys.argv
    have_key = bool(os.environ.get("ODDS_API_KEY"))
    regions = os.environ.get("ODDS_REGIONS", "uk")

    baseline = now.hour in BASELINE_HOURS and now.minute < 30

    # Any past-kickoff game still without a winner (incl. one a missed/late cron
    # never caught). No upper time bound — so nothing can be silently left
    # unresolved. We check these on EVERY run (GitHub's cron is unreliable, and
    # credits are plentiful), not just at the baseline.
    pending, inplay = [], []
    for rnd in state["bracket"].values():
        for m in rnd:
            if m.get("teamA") and m.get("teamB") and m.get("winner") is None:
                ko = parse_iso(m.get("kickoff"))
                if not ko:
                    continue
                age = (now - ko).total_seconds() / 60
                if age >= SCORE_CHECK_MIN:
                    pending.append(m["id"])
                if 0 <= age <= SCORE_CHECK_MAX:
                    inplay.append(m["id"])   # in play / just finished -> live odds

    check_results = forced or bool(pending)

    if not have_key and (check_results or baseline or inplay):
        print("ERROR: ODDS_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    changed = False
    newly = []

    # 1) Poll results -> auto-set winners. Penalty shootouts (level scores) are
    #    resolved from the outright market (the loser drops out).
    if have_key and check_results:
        print(f"Checking results — pending:{len(pending)} inplay:{len(inplay)}"
              f"{' (forced)' if forced else ''}", file=sys.stderr)
        newly, level = apply_scores(state, fetch_scores())
        if level:
            newly += resolve_penalties(level, set(fetch_outrights(regions)))
        if newly:
            changed = True

    # Advance BEFORE fetching odds so any newly-revealed next-round matchups get
    # their kickoff time + h2h odds in this same run (no one-cycle lag).
    wc_lib.advance(state)

    # 2) Refresh odds: at the baseline, when forced, when a result just landed,
    #    OR while a game is in play (live odds) — but throttled so frequent
    #    result-polling doesn't burn credits on odds every few minutes.
    last_odds = parse_iso(state.get("oddsCheckedAt"))
    odds_due = last_odds is None or (now - last_odds).total_seconds() / 60 >= ODDS_THROTTLE_MIN
    if have_key and (baseline or forced or newly or (inplay and odds_due)):
        fetch_and_apply_odds(state, regions)
        state["oddsCheckedAt"] = now.isoformat()
        changed = True

    if not (check_results or baseline or inplay):
        print("Nothing due — no API call.", file=sys.stderr)

    # When a result lands, freeze each player's pre-result rank so the site can
    # show stock-exchange ▲/▼ movement until the next match decides.
    if newly:
        for p in state["players"]:
            p["prevRank"] = ranks_before[p["id"]]

    if changed:
        # Projected reach-% for every team (drives the coloured future-bracket
        # slots). Cheap, local — recomputed whenever results/odds move.
        wc_lib.compute_reach(state)
        state["source"] = "the-odds-api"
        state["updatedAt"] = now.isoformat()
        STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                              encoding="utf-8")
        append_history(state)
        print("Wrote", STATE_PATH, file=sys.stderr)
    else:
        print("No state change — not writing.", file=sys.stderr)


if __name__ == "__main__":
    main()
