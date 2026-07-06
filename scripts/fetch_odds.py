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

# Credit budget: the paid Odds API is only for ODDS now — results/eliminations
# come from the free feed (apply_feed_results). So we spend a credit only to
# refresh odds: at a small daily baseline, and (throttled) while a game is
# actually being played. The Odds-API result endpoint is kept as a rare safety
# net for a game the free feed somehow failed to resolve for hours.
BASELINE_HOURS = (7, 19)              # UTC hours for the 2x/day odds baseline
ODDS_THROTTLE_MIN = 30                # min minutes between live odds refreshes
LIVE_ODDS_MAX = 130                   # only refresh live odds while a game is
                                      # actually on (mins after KO), not for hours
STALE_PENDING_MIN = 180               # only fall back to the paid result endpoint
                                      # if the free feed hasn't resolved a game
                                      # this many minutes after kickoff
CREDIT_RESERVE = 30                   # stop spending on live odds below this many
                                      # remaining credits (baseline still probes,
                                      # so it self-heals after the monthly reset)
ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / "data" / "state.json"
API_REMAINING = None                  # x-requests-remaining from the last call

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
    global API_REMAINING
    params = {**params, "apiKey": os.environ["ODDS_API_KEY"]}
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=30) as r:
        remaining = r.headers.get("x-requests-remaining")
        if remaining is not None:
            print(f"  credits remaining: {remaining}", file=sys.stderr)
            try:
                API_REMAINING = int(remaining)
            except ValueError:
                pass
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


# ---- Free result feed (worldcup26.ir): no key, no quota. Primary source for
#      resolving finished matches so eliminations keep working even when the
#      paid Odds API runs out of monthly credits. ----
LIVE_FEED_URL = "https://worldcup26.ir/get/games"
FEED_NAME_MAP = {
    "Bosnia and Herzegovina": "Bosnia", "Czech Republic": "Czechia",
    "Democratic Republic of the Congo": "DR Congo", "South Korea": "Korea Republic",
    "Turkey": "Türkiye", "United States": "USA", "Cote d'Ivoire": "Ivory Coast",
    "Cabo Verde": "Cape Verde", "Curacao": "Curaçao",
}


def feed_canon(n):
    return FEED_NAME_MAP.get((n or "").strip(), (n or "").strip())


def _to_int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def fetch_live_feed():
    """Whole-tournament game list with statuses/scores. Returns [] on failure."""
    try:
        req = urllib.request.Request(LIVE_FEED_URL, headers={"User-Agent": "wc-bot"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("games", [])
    except Exception as e:  # noqa: BLE001 — best-effort, never fatal
        print(f"live feed fetch failed: {e}", file=sys.stderr)
        return []


def apply_feed_results(state):
    """Set winner + score on finished bracket matches using the free feed.

    Handles penalty shootouts via the feed's penalty tallies. Only knockout
    feed games are considered (skip single-letter group-stage entries) to avoid
    matching an unrelated earlier meeting. Returns ids newly decided.
    """
    finished = {}
    for g in fetch_live_feed():
        grp = str(g.get("group", "")).strip().upper()
        if len(grp) == 1 and grp.isalpha():       # group stage — ignore
            continue
        te = str(g.get("time_elapsed", "")).lower()
        if not (te == "finished" or str(g.get("finished", "")).upper() == "TRUE"):
            continue
        h, a = feed_canon(g.get("home_team_name_en")), feed_canon(g.get("away_team_name_en"))
        hs, as_ = _to_int(g.get("home_score")), _to_int(g.get("away_score"))
        if not h or not a or hs is None or as_ is None:
            continue
        finished[frozenset((h, a))] = {
            "h": h, "hs": hs, "as": as_,
            "hp": _to_int(g.get("home_penalty_score")),
            "ap": _to_int(g.get("away_penalty_score")),
        }

    newly = []
    for rnd in state["bracket"].values():
        for m in rnd:
            a_name, b_name = m.get("teamA"), m.get("teamB")
            if not (a_name and b_name) or m.get("winner") is not None:
                continue
            g = finished.get(frozenset((a_name, b_name)))
            if not g:
                continue
            sa = g["hs"] if a_name == g["h"] else g["as"]
            sb = g["hs"] if b_name == g["h"] else g["as"]
            m["score"] = f"{sa}–{sb}"
            if sa != sb:
                m["winner"] = "A" if sa > sb else "B"
                newly.append(m["id"])
                print(f"Feed result: {a_name} {sa}-{sb} {b_name} -> {m['winner']}", file=sys.stderr)
            else:
                pa = g["hp"] if a_name == g["h"] else g["ap"]
                pb = g["hp"] if b_name == g["h"] else g["ap"]
                if pa is not None and pb is not None and pa != pb:
                    m["winner"] = "A" if pa > pb else "B"
                    m["score"] = f"{sa}–{sb} ({pa}-{pb} p)"
                    newly.append(m["id"])
                    print(f"Feed shootout: {a_name} v {b_name} {sa}-{sb} pens {pa}-{pb} "
                          f"-> {m['winner']}", file=sys.stderr)
    return newly


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

    # Classify undecided known matches by their age since kickoff:
    #   * inplay_odds  — actually being played -> worth a (throttled) live-odds
    #                    refresh; bounded so we don't refresh odds for hours.
    #   * stale_pending — the free feed *should* have resolved it by now; only
    #                    then do we spend paid credits on the result endpoint.
    inplay_odds, stale_pending = [], []
    for rnd in state["bracket"].values():
        for m in rnd:
            if m.get("teamA") and m.get("teamB") and m.get("winner") is None:
                ko = parse_iso(m.get("kickoff"))
                if not ko:
                    continue
                age = (now - ko).total_seconds() / 60
                if -5 <= age <= LIVE_ODDS_MAX:
                    inplay_odds.append(m["id"])
                if age >= STALE_PENDING_MIN:
                    stale_pending.append(m["id"])

    check_results = forced or bool(stale_pending)

    if not have_key:
        print("No ODDS_API_KEY — running on the free result feed only "
              "(odds won't refresh).", file=sys.stderr)

    changed = False
    newly = []

    # 1a) Resolve finished matches from the FREE feed first (no key, no quota).
    #     Primary elimination source — keeps working when the paid Odds API is
    #     exhausted or unset.
    feed_newly = apply_feed_results(state)
    if feed_newly:
        newly += feed_newly
        changed = True

    # 1b) Paid result endpoint ONLY as a rare safety net — a game the free feed
    #     hasn't resolved hours after kickoff. NON-FATAL: a dead/quota'd key must
    #     never abort the run and block the feed's results.
    if have_key and check_results:
        try:
            print(f"Feed miss — checking paid results for {len(stale_pending)} "
                  f"stale game(s){' (forced)' if forced else ''}", file=sys.stderr)
            api_newly, level = apply_scores(state, fetch_scores())
            if level:
                api_newly += resolve_penalties(level, set(fetch_outrights(regions)))
            if api_newly:
                newly += api_newly
                changed = True
        except Exception as e:  # noqa: BLE001
            print(f"Paid result check failed (continuing on feed): {e}", file=sys.stderr)

    # Advance BEFORE fetching odds so any newly-revealed next-round matchups get
    # their kickoff time + h2h odds in this same run (no one-cycle lag).
    wc_lib.advance(state)

    # 2) Refresh odds — the only routine credit spend. At the daily baseline,
    #    when forced, when a result just landed, or (throttled) while a game is
    #    actually being played. Below the reserve we still probe at the baseline
    #    (2x/day) so it self-heals after the monthly reset, but skip live odds.
    prev_remaining = state.get("apiRemaining")
    reserve_ok = prev_remaining is None or prev_remaining > CREDIT_RESERVE
    last_odds = parse_iso(state.get("oddsCheckedAt"))
    odds_due = last_odds is None or (now - last_odds).total_seconds() / 60 >= ODDS_THROTTLE_MIN
    # The workflow ticks every ~5 min, so EVERYTHING except a fresh result is
    # throttled to at most one refresh per ODDS_THROTTLE_MIN — otherwise a
    # baseline/live window would refresh 6x. Baseline still probes below the
    # reserve (self-heals after the monthly reset); live odds do not.
    want_odds = (forced or newly
                 or (baseline and odds_due)
                 or (bool(inplay_odds) and odds_due and reserve_ok))
    if have_key and want_odds:
        try:
            fetch_and_apply_odds(state, regions)
            state["oddsCheckedAt"] = now.isoformat()
            changed = True
        except Exception as e:  # noqa: BLE001
            print(f"Odds refresh failed (continuing): {e}", file=sys.stderr)
    elif have_key and bool(inplay_odds) and odds_due and not reserve_ok:
        print(f"Conserving credits (remaining {prev_remaining}) — skipping live "
              f"odds; results still tracked via the free feed.", file=sys.stderr)

    # Remember the credit balance so the reserve guard works across runs.
    if API_REMAINING is not None:
        state["apiRemaining"] = API_REMAINING

    if not (check_results or baseline or inplay_odds):
        print("Nothing due — no paid API call.", file=sys.stderr)

    # When a result lands, freeze each player's pre-result rank so the site can
    # show stock-exchange ▲/▼ movement until the next match decides.
    if newly:
        for p in state["players"]:
            p["prevRank"] = ranks_before[p["id"]]

    # Persist a bare credit-balance update even if nothing else changed, so the
    # reserve guard reflects spend from a probe that found no new result.
    credit_only = not changed and API_REMAINING is not None and API_REMAINING != prev_remaining

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
    elif credit_only:
        STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                              encoding="utf-8")
        print(f"Credit balance updated ({API_REMAINING}) — no data change.", file=sys.stderr)
    else:
        print("No state change — not writing.", file=sys.stderr)


if __name__ == "__main__":
    main()
