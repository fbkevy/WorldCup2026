"""Shared helpers for the World Cup Draw data: load/save and bracket progression."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE_PATH = ROOT / "data" / "state.json"

# Knockout rounds in order, with match counts.
ROUND_ORDER = [("R32", 16), ("R16", 8), ("QF", 4), ("SF", 2), ("F", 1)]


def load():
    return json.loads(STATE_PATH.read_text(encoding="utf-8"))


def save(state):
    STATE_PATH.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                          encoding="utf-8")


def winner_team(match):
    if match.get("winner") == "A":
        return match.get("teamA")
    if match.get("winner") == "B":
        return match.get("teamB")
    return None


def loser_team(match):
    if match.get("winner") == "A":
        return match.get("teamB")
    if match.get("winner") == "B":
        return match.get("teamA")
    return None


def advance(state):
    """Propagate decided matches up the bracket and mark losers eliminated.

    Idempotent: safe to run on every odds refresh. Winners (set via each match's
    `winner` = "A"/"B") are placed into the next round; losing teams get alive=False.
    """
    bracket = state["bracket"]
    teams = state["teams"]

    # 1) Mark eliminated teams from decided matches across all rounds.
    for rnd in bracket.values():
        for m in rnd:
            lost = loser_team(m)
            if lost and lost in teams:
                teams[lost]["alive"] = False
                teams[lost]["winProb"] = 0.0

    # 2) Feed winners into the next round (feeder matches 2k, 2k+1 -> slot k).
    for (cur, _), (nxt, ncount) in zip(ROUND_ORDER, ROUND_ORDER[1:]):
        cur_matches = bracket.get(cur, [])
        nxt_matches = bracket.get(nxt, [])
        for k in range(ncount):
            slot = nxt_matches[k]
            fa = winner_team(cur_matches[2 * k]) if 2 * k < len(cur_matches) else None
            fb = winner_team(cur_matches[2 * k + 1]) if 2 * k + 1 < len(cur_matches) else None
            slot["teamA"] = fa
            slot["teamB"] = fb
            # Clear stale probabilities/winner if the matchup isn't fully set.
            if not (fa and fb):
                slot["probA"] = slot["probB"] = None
                if slot.get("winner") and (fa is None or fb is None):
                    slot["winner"] = None

    # 3) Advance the "current round" pointer to the earliest round with an
    #    undecided, fully-known match (so the site auto-scrolls there).
    current = state.get("currentRound", "R32")
    for key, _ in ROUND_ORDER:
        live = [m for m in bracket.get(key, [])
                if m.get("teamA") and m.get("teamB") and m.get("winner") is None]
        if live:
            current = key
            break
    else:
        # everything decided up to a champion -> stay on the Final
        current = "F"
    state["currentRound"] = current
    return state


def compute_reach(state):
    """Per-team probability of reaching each knockout round (projected %s).

    Bottom-up single-elimination DP. For each match we hold a distribution over
    which team wins it:
      * a decided match collapses to its winner (prob 1);
      * a set matchup uses the real h2h odds (probA/probB);
      * a future (unset) matchup uses a Bradley-Terry estimate from each team's
        tournament-winner odds: P(t beats u) = w_t / (w_t + w_u).
    The winner distribution of a round-(R-1) match is exactly each team's chance
    of appearing in round R. Result is stored as
        teams[t]["reach"] = {"R32":1, "R16":.., "QF":.., "SF":.., "F":.., "W":..}
    (keys omitted when ~0). Used by the UI to colour future bracket slots.
    """
    bracket = state["bracket"]
    teams = state["teams"]

    def strength(t):
        info = teams.get(t, {})
        if not t or not info.get("alive", True):
            return 0.0
        return max(float(info.get("winProb") or 0.0), 1e-9)

    def pwin(t, u):
        st, su = strength(t), strength(u)
        if st <= 0 and su <= 0:
            return 0.5
        return st / (st + su)

    def match_dist(m):
        """Winner distribution from a match's own two teams."""
        a, b, w = m.get("teamA"), m.get("teamB"), winner_team(m)
        if w:
            return {w: 1.0}
        if a and b:
            pa, pb = m.get("probA"), m.get("probB")
            if pa is not None and pb is not None and (pa + pb) > 0:
                return {a: pa / (pa + pb), b: pb / (pa + pb)}
            p = pwin(a, b)
            return {a: p, b: 1.0 - p}
        return {a: 1.0} if a else ({b: 1.0} if b else {})

    def combine(d1, d2, slot):
        """Winner distribution of a match whose two sides are distributions."""
        w = winner_team(slot)
        if w:
            return {w: 1.0}
        sa, sb, pa, pb = (slot.get("teamA"), slot.get("teamB"),
                          slot.get("probA"), slot.get("probB"))
        if sa and sb and pa is not None and pb is not None and (pa + pb) > 0:
            return {sa: pa / (pa + pb), sb: pb / (pa + pb)}
        out = {}
        for t, pt in d1.items():
            out[t] = pt * sum(pu * pwin(t, u) for u, pu in d2.items())
        for u, pu in d2.items():
            out[u] = pu * sum(pt * pwin(u, t) for t, pt in d1.items())
        return out

    reach = {t: {} for t in teams}
    dists = {}  # (round, idx) -> winner distribution

    for i, m in enumerate(bracket.get("R32", [])):
        for t in (m.get("teamA"), m.get("teamB")):
            if t:
                reach.setdefault(t, {})["R32"] = 1.0
        dists[("R32", i)] = match_dist(m)

    for (cur, _), (nxt, ncount) in zip(ROUND_ORDER, ROUND_ORDER[1:]):
        nxt_matches = bracket.get(nxt, [])
        for k in range(ncount):
            d1 = dists.get((cur, 2 * k), {})
            d2 = dists.get((cur, 2 * k + 1), {})
            for t, p in {**d1, **d2}.items():
                reach.setdefault(t, {})[nxt] = p
            slot = nxt_matches[k] if k < len(nxt_matches) else {}
            dists[(nxt, k)] = combine(d1, d2, slot)

    for t, p in dists.get(("F", 0), {}).items():
        reach.setdefault(t, {})["W"] = p

    for t, info in teams.items():
        info["reach"] = {k: round(v, 5) for k, v in reach.get(t, {}).items() if v > 1e-6}
    return state
