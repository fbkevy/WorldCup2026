"""
Generates data/state.json with the real player/team allocation and PLACEHOLDER
odds, plus a sample knockout bracket. This lets us see the site before the live
odds scraper is wired up. The real scraper will produce the same JSON shape.

Run:  python scripts/build_sample.py
"""
import json
import datetime
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import wc_lib

# --- Players, colours, and their teams -------------------------------------
PLAYERS = [
    ("paul",   "Paul",   "#e6394a"),
    ("caoimh", "Caoimh", "#f76707"),
    ("fran",   "Fran",   "#2f9e44"),
    ("kev",    "Kev",    "#1c7ed6"),
    ("dave",   "Dave",   "#7048e8"),
    ("dec",    "Dec",    "#ffd43b"),
]

ALLOCATION = {
    "paul":   ["Spain", "Ecuador", "Algeria", "Scotland", "Panama"],
    "caoimh": ["France", "Mexico", "Uruguay", "Paraguay", "Iran", "Uzbekistan"],
    "fran":   ["England", "Norway", "Japan", "Türkiye", "Canada", "Egypt",
               "DR Congo", "Jordan", "Saudi Arabia", "Haiti"],
    "kev":    ["Portugal", "Belgium", "Morocco", "USA", "Sweden", "Czechia",
               "Ghana", "Cape Verde", "Qatar", "Curaçao"],
    "dave":   ["Argentina", "Germany", "Senegal", "Croatia", "Bosnia",
               "Korea Republic", "Tunisia"],
    "dec":    ["Brazil", "Netherlands", "Colombia", "Switzerland", "Austria",
               "Ivory Coast", "Australia", "Iraq", "New Zealand", "South Africa"],
}

# --- Placeholder relative strengths (NOT real odds) ------------------------
# Used only to seed believable numbers for the skeleton. The live scraper
# replaces all of this with real bookmaker-implied probabilities.
STRENGTH = {
    "Spain": 90, "France": 88, "Brazil": 86, "Argentina": 92, "England": 85,
    "Portugal": 80, "Germany": 78, "Netherlands": 74, "Belgium": 60,
    "Croatia": 55, "Uruguay": 58, "Colombia": 56, "Morocco": 54, "Japan": 45,
    "USA": 44, "Mexico": 46, "Switzerland": 42, "Senegal": 43, "Norway": 48,
    "Türkiye": 38, "Ecuador": 36, "Austria": 37, "Korea Republic": 34,
    "Ivory Coast": 33, "Sweden": 35, "Czechia": 32, "Egypt": 31, "Australia": 30,
    "Canada": 29, "Paraguay": 28, "Iran": 30, "Ghana": 27, "Algeria": 28,
    "Scotland": 26, "Uzbekistan": 22, "Qatar": 21, "DR Congo": 23, "Tunisia": 24,
    "Saudi Arabia": 22, "Panama": 18, "Cape Verde": 17, "Jordan": 16,
    "Iraq": 18, "Bosnia": 25, "South Africa": 19, "Haiti": 12, "Curaçao": 11,
    "New Zealand": 14,
}

OWNER_OF = {team: pid for pid, teams in ALLOCATION.items() for team in teams}


def normalize(weights):
    total = sum(weights.values())
    return {k: v / total for k, v in weights.items()}


def main():
    win_prob = normalize(STRENGTH)  # tournament-win prob, sums to 1.0

    teams = {
        team: {
            "owner": OWNER_OF[team],
            "winProb": round(win_prob[team], 5),
            "alive": True,
        }
        for team in OWNER_OF
    }

    players = [
        {
            "id": pid,
            "name": name,
            "color": color,
            "teams": ALLOCATION[pid],
        }
        for pid, name, color in PLAYERS
    ]

    # --- Sample Round of 32: pick the 32 strongest as a stand-in -----------
    top32 = sorted(STRENGTH, key=STRENGTH.get, reverse=True)[:32]
    # Pair them 1-v-32, 2-v-31, ... for a plausible-looking bracket.
    pairs = [(top32[i], top32[31 - i]) for i in range(16)]

    def h2h(a, b):
        sa, sb = STRENGTH[a], STRENGTH[b]
        pa = sa / (sa + sb)
        return round(pa, 3), round(1 - pa, 3)

    # Mark the first 4 R32 matches as decided (favourite wins) so the skeleton
    # demonstrates eliminations + auto-advance into R16.
    # Kickoffs stored as canonical UTC (Z); the site converts to each viewer's
    # local timezone, which fixes cross-date-line wrong-date issues.
    base = datetime.datetime(2026, 6, 28, 16, 0, tzinfo=datetime.timezone.utc)
    slots = [16, 19, 22, 25]  # UTC kickoff hours/day (25 == 01:00 next day)
    r32 = []
    for i, (a, b) in enumerate(pairs):
        pa, pb = h2h(a, b)
        winner = "A" if i < 4 else None
        kickoff = base + datetime.timedelta(days=i // 4, hours=slots[i % 4] - 16)
        r32.append({
            "id": f"r32-{i+1}",
            "teamA": a, "teamB": b,
            "probA": pa, "probB": pb,
            "winner": winner,
            "kickoff": kickoff.isoformat().replace("+00:00", "Z"),
        })

    def empty_round(name, count):
        return [{"id": f"{name}-{i+1}", "teamA": None, "teamB": None,
                 "probA": None, "probB": None, "winner": None, "kickoff": None}
                for i in range(count)]

    bracket = {
        "R32": r32,
        "R16": empty_round("r16", 8),
        "QF":  empty_round("qf", 4),
        "SF":  empty_round("sf", 2),
        "F":   empty_round("f", 1),
    }

    state = {
        "updatedAt": datetime.datetime.now(datetime.timezone.utc)
                       .replace(microsecond=0).isoformat(),
        "source": "placeholder",
        "currentRound": "R32",
        "players": players,
        "teams": teams,
        "bracket": bracket,
    }

    wc_lib.advance(state)  # apply eliminations + advance winners into R16

    out = pathlib.Path(__file__).resolve().parent.parent / "data" / "state.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
