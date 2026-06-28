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
