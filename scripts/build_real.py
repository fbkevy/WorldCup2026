"""
One-time builder: replace the placeholder bracket with the REAL Round of 32
from The Odds API — real teams, real h2h odds, real kickoff times — and real
tournament-win probabilities. Keeps player ownership from data/state.json.

Teams not in the live knockout field are marked eliminated (they didn't qualify
from the group stage). Later rounds start empty and fill in as results are set.

NOTE: R32 matches are seeded in kickoff order. The R32->R16 advancement adjacency
(who would meet whom) therefore follows that order; reorder the 16 matches in
state.json if you want it to match the official bracket exactly.

Run:  ODDS_API_KEY=xxxx python scripts/build_real.py
"""
import os
import sys
import json
import datetime
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wc_lib
import fetch_odds as fo


def main():
    if not os.environ.get("ODDS_API_KEY"):
        print("ERROR: ODDS_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    regions = os.environ.get("ODDS_REGIONS", "uk")

    state = wc_lib.load()
    teams = state["teams"]

    # Pull real data.
    win = fo.fetch_outrights(regions)          # {team: winProb}
    h2h = fo.fetch_match_h2h(regions)          # {frozenset(pair): {probs, kickoff}}

    # Official 2026 R32 order so that adjacent-pair advancement (wc_lib.advance)
    # reproduces the real bracket. Derived from the FIFA match-number tree:
    # leaf order = matches [74,77,73,75,83,84,81,82,76,78,79,80,86,88,85,87].
    # Each entry is the pair of (our canonical) team names for that match.
    OFFICIAL_R32_ORDER = [
        {"Germany", "Paraguay"},        # 74
        {"France", "Sweden"},           # 77
        {"Canada", "South Africa"},     # 73
        {"Netherlands", "Morocco"},     # 75
        {"Portugal", "Croatia"},        # 83
        {"Spain", "Austria"},           # 84
        {"USA", "Bosnia"},              # 81
        {"Belgium", "Senegal"},         # 82
        {"Brazil", "Japan"},            # 76
        {"Ivory Coast", "Norway"},      # 78
        {"Mexico", "Ecuador"},          # 79
        {"England", "DR Congo"},        # 80
        {"Argentina", "Cape Verde"},    # 86
        {"Australia", "Egypt"},         # 88
        {"Switzerland", "Algeria"},     # 85
        {"Colombia", "Ghana"},          # 87
    ]
    by_pair = {frozenset(p): info for p, info in h2h.items()}

    r32 = []
    alive = set()
    for i, pair in enumerate(OFFICIAL_R32_ORDER, start=1):
        info = by_pair.get(frozenset(pair))
        if not info:
            print(f"WARNING: official pair {pair} not found in API fixtures",
                  file=sys.stderr)
            continue
        probs = info["probs"]
        a, b = sorted(probs, key=lambda t: -probs[t])  # favourite first
        alive.update([a, b])
        r32.append({
            "id": f"r32-{i}", "teamA": a, "teamB": b,
            "probA": probs[a], "probB": probs[b],
            "winner": None, "kickoff": info.get("kickoff") or None,
        })

    # Sanity: warn about any R32 team we can't map to an owner.
    unknown = sorted(t for t in alive if t not in teams)
    if unknown:
        print("WARNING: R32 teams not in our allocation (add to NAME_MAP): "
              + ", ".join(unknown), file=sys.stderr)

    # Eliminate teams that didn't reach the knockouts; set win probs.
    for name, info in teams.items():
        if name in alive:
            info["alive"] = True
            if name in win:
                info["winProb"] = round(win[name], 5)
        else:
            info["alive"] = False
            info["winProb"] = 0.0

    def empty(name, n):
        return [{"id": f"{name}-{i+1}", "teamA": None, "teamB": None,
                 "probA": None, "probB": None, "winner": None, "kickoff": None}
                for i in range(n)]

    state["bracket"] = {
        "R32": r32, "R16": empty("r16", 8), "QF": empty("qf", 4),
        "SF": empty("sf", 2), "F": empty("f", 1),
    }
    state["postFetched"] = []
    wc_lib.advance(state)
    state["source"] = "the-odds-api"
    state["updatedAt"] = (datetime.datetime.now(datetime.timezone.utc)
                          .replace(microsecond=0).isoformat())
    wc_lib.save(state)
    print(f"Built real R32: {len(r32)} matches, {len(alive)} teams alive.",
          file=sys.stderr)


if __name__ == "__main__":
    main()
