"""Self-test for bracket progression. Run: python scripts/test_wc_lib.py"""
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wc_lib


def make_state():
    """32 teams t0..t31, each owned by player p(i%2). Empty bracket beyond R32."""
    teams = {f"t{i}": {"owner": f"p{i % 2}", "winProb": 1 / 32, "alive": True}
             for i in range(32)}
    r32 = [{"id": f"r32-{k}", "teamA": f"t{2*k}", "teamB": f"t{2*k+1}",
            "probA": 0.5, "probB": 0.5, "winner": None} for k in range(16)]

    def empty(name, n):
        return [{"id": f"{name}-{k}", "teamA": None, "teamB": None,
                 "probA": None, "probB": None, "winner": None} for k in range(n)]

    return {"currentRound": "R32", "source": "test",
            "teams": teams,
            "bracket": {"R32": r32, "R16": empty("r16", 8), "QF": empty("qf", 4),
                        "SF": empty("sf", 2), "F": empty("f", 1)}}


def decide_round(state, key, pick="A"):
    for m in state["bracket"][key]:
        if m["teamA"] and m["teamB"]:
            m["winner"] = pick


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok:", msg)


def main():
    s = make_state()

    # Win R32 (teamA wins every match) -> 16 eliminated, R16 populated.
    decide_round(s, "R32", "A")
    wc_lib.advance(s)
    alive = sum(1 for t in s["teams"].values() if t["alive"])
    check(alive == 16, f"16 teams alive after R32 (got {alive})")
    check(s["bracket"]["R16"][0]["teamA"] == "t0", "R16[0].A = winner of r32-0")
    check(s["bracket"]["R16"][0]["teamB"] == "t2", "R16[0].B = winner of r32-1")
    check(s["currentRound"] == "R16", "current round advanced to R16")

    # Play out R16, QF, SF.
    for key, n in (("R16", 8), ("QF", 4), ("SF", 2)):
        decide_round(s, key, "A")
        wc_lib.advance(s)
    check(s["bracket"]["F"][0]["teamA"] and s["bracket"]["F"][0]["teamB"],
          "Final has both finalists")
    check(s["currentRound"] == "F", "current round is the Final")

    # Decide the Final -> one champion, exactly one alive team.
    decide_round(s, "F", "A")
    wc_lib.advance(s)
    alive = [t for t, i in s["teams"].items() if i["alive"]]
    champ_match = s["bracket"]["F"][0]
    champ = champ_match["teamA"] if champ_match["winner"] == "A" else champ_match["teamB"]
    check(len(alive) == 1, f"exactly one team alive at the end (got {len(alive)})")
    check(alive[0] == champ, "the surviving team is the Final winner")

    print("ALL PASSED — champion:", champ)


if __name__ == "__main__":
    main()
