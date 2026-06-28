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

    # Build R32 from the real fixtures, sorted by kickoff time.
    events = []
    for pair, info in h2h.items():
        a, b = sorted(info["probs"], key=lambda t: -info["probs"][t])  # favourite first
        events.append((info.get("kickoff") or "", a, b, info["probs"]))
    events.sort(key=lambda e: e[0])

    r32 = []
    alive = set()
    for i, (kickoff, a, b, probs) in enumerate(events, start=1):
        alive.update([a, b])
        r32.append({
            "id": f"r32-{i}", "teamA": a, "teamB": b,
            "probA": probs[a], "probB": probs[b],
            "winner": None, "kickoff": kickoff or None,
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
