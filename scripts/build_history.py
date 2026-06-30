"""
Seed data/history.json from git history: each past commit of data/state.json
becomes one snapshot of every player's combined win probability. The scraper
appends to this file going forward (see fetch_odds.append_history).

Run:  python scripts/build_history.py
"""
import json
import subprocess
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "history.json"


def player_probs(state):
    return {p["id"]: round(sum(state["teams"][t]["winProb"]
                               for t in p["teams"] if state["teams"][t].get("alive")), 5)
            for p in state["players"]}


def main():
    commits = subprocess.run(
        ["git", "log", "--reverse", "--format=%H", "--", "data/state.json"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout.split()

    snaps, seen = [], set()
    for c in commits:
        blob = subprocess.run(["git", "show", f"{c}:data/state.json"],
                              cwd=ROOT, capture_output=True, text=True,
                              encoding="utf-8").stdout
        if not blob.strip():
            continue
        try:
            state = json.loads(blob)
        except json.JSONDecodeError:
            continue
        t = state.get("updatedAt")
        if not t or t in seen:
            continue
        seen.add(t)
        snaps.append({"t": t, "probs": player_probs(state)})

    OUT.write_text(json.dumps({"snapshots": snaps}, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {OUT} with {len(snaps)} snapshots")


if __name__ == "__main__":
    main()
