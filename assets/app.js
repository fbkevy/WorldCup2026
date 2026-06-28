"use strict";

const ROUNDS = [
  ["R32", "Round of 32"],
  ["R16", "Round of 16"],
  ["QF", "Quarter-finals"],
  ["SF", "Semi-finals"],
  ["F", "Final"],
];

let STATE = null;
let PLAYER_BY_ID = {};
let selectedPlayer = null;
let collapsedRounds = {};   // round key -> manual collapse override

const pct = (p) => (p == null ? "" : Math.round(p * 100) + "%");
const $ = (sel) => document.querySelector(sel);

// FIFA-style 3-letter codes so cards stay narrow. Falls back to first 3 letters.
const ABBR = {
  "Spain": "ESP", "Ecuador": "ECU", "Algeria": "ALG", "Scotland": "SCO",
  "Panama": "PAN", "France": "FRA", "Mexico": "MEX", "Uruguay": "URU",
  "Paraguay": "PAR", "Iran": "IRN", "Uzbekistan": "UZB", "England": "ENG",
  "Norway": "NOR", "Japan": "JPN", "Türkiye": "TUR", "Canada": "CAN",
  "Egypt": "EGY", "DR Congo": "COD", "Jordan": "JOR", "Saudi Arabia": "KSA",
  "Haiti": "HAI", "Portugal": "POR", "Belgium": "BEL", "Morocco": "MAR",
  "USA": "USA", "Sweden": "SWE", "Czechia": "CZE", "Ghana": "GHA",
  "Cape Verde": "CPV", "Qatar": "QAT", "Curaçao": "CUW", "Argentina": "ARG",
  "Germany": "GER", "Senegal": "SEN", "Croatia": "CRO", "Bosnia": "BIH",
  "Korea Republic": "KOR", "Tunisia": "TUN", "Brazil": "BRA",
  "Netherlands": "NED", "Colombia": "COL", "Switzerland": "SUI",
  "Austria": "AUT", "Ivory Coast": "CIV", "Australia": "AUS", "Iraq": "IRQ",
  "New Zealand": "NZL", "South Africa": "RSA",
};
const abbr = (name) => ABBR[name] || (name || "").slice(0, 3).toUpperCase();

// Format a UTC ISO kickoff in the viewer's own timezone. Because the source is
// canonical UTC, the local date is always correct even across the date line.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
function localKickoff(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

async function load() {
  const res = await fetch("data/state.json?t=" + Date.now());
  STATE = await res.json();
  PLAYER_BY_ID = Object.fromEntries(STATE.players.map((p) => [p.id, p]));
  render();
}

function playerProb(player) {
  // Sum of tournament-win probs for this player's still-alive teams.
  return player.teams.reduce((sum, t) => {
    const team = STATE.teams[t];
    return sum + (team && team.alive ? team.winProb : 0);
  }, 0);
}

function aliveCount() {
  return Object.values(STATE.teams).filter((t) => t.alive).length;
}

function render() {
  renderStandings();
  renderBracket();
  $("#updated-at").textContent = new Date(STATE.updatedAt).toLocaleString();
  $("#alive-count").textContent = aliveCount();
  renderSourceBadge();
  renderChampion();
  // Layout-dependent passes run after the browser lays the bracket out.
  requestAnimationFrame(() => {
    drawConnectors();
    scrollToNextGame();
  });
}

function renderSourceBadge() {
  const badge = $("#source-badge");
  const live = STATE.source && STATE.source !== "placeholder";
  badge.textContent = live ? "LIVE ODDS" : "SAMPLE ODDS";
  badge.className = "badge " + (live ? "live" : "sample");
}

function renderChampion() {
  const el = $("#champion");
  const final = (STATE.bracket.F || [])[0];
  const champ = final && (final.winner === "A" ? final.teamA : final.winner === "B" ? final.teamB : null);
  if (!champ) { el.hidden = true; return; }
  const owner = PLAYER_BY_ID[STATE.teams[champ]?.owner];
  el.hidden = false;
  el.innerHTML = `<span class="dot" style="background:${owner ? owner.color : ""}"></span>
    🏆 Champions: <strong>${champ}</strong>${owner ? ` — ${owner.name} wins the draw!` : ""}`;
}

function renderStandings() {
  const ranked = [...STATE.players]
    .map((p) => ({ p, prob: playerProb(p) }))
    .sort((a, b) => b.prob - a.prob);

  const list = $("#standings-list");
  list.innerHTML = "";
  ranked.forEach(({ p, prob }, i) => {
    const aliveTeams = p.teams.filter((t) => STATE.teams[t]?.alive).length;
    const li = document.createElement("li");
    li.className = "standings-row" + (prob <= 0 ? " out" : "") +
      (selectedPlayer === p.id ? " selected" : "");
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="dot" style="background:${p.color}"></span>
      <span class="pname">${p.name}</span>
      <span class="pteams">${aliveTeams}/${p.teams.length}</span>
      <span class="pprob">${pct(prob)}</span>`;
    li.addEventListener("click", () => togglePlayer(p.id));
    list.appendChild(li);
  });

  const leader = ranked[0];
  $("#standings-peek").textContent = leader ? `${leader.p.name} ${pct(leader.prob)}` : "";
}

function ownerTag(teamName) {
  const team = STATE.teams[teamName];
  if (!team) return "";
  const owner = PLAYER_BY_ID[team.owner];
  return owner ? owner.name : "";
}
function ownerColor(teamName) {
  const team = STATE.teams[teamName];
  const owner = team && PLAYER_BY_ID[team.owner];
  return owner ? owner.color : "transparent";
}

function teamRow(teamName, prob, match, side) {
  if (!teamName) {
    return `<div class="team-row tbd-row"><span class="team-code tbd-name">—</span></div>`;
  }
  const team = STATE.teams[teamName];
  const decided = match.winner != null;
  const isWinner = match.winner === side;
  const owner = team?.owner;
  const sel = selectedPlayer && owner === selectedPlayer ? " match-team-selected" : "";
  const cls = decided ? (isWinner ? " winner" : " loser") : "";
  // Show % only when BOTH teams known (head-to-head set) and not yet decided.
  const showProb = match.teamA && match.teamB && !decided;
  const right = showProb
    ? `<span class="team-prob">${pct(prob)}</span>`
    : (decided && isWinner ? `<span class="adv" aria-label="advances">▸</span>` : "");
  return `
    <div class="team-row${cls}${sel}" data-owner="${owner || ""}" data-team="${teamName}"
         title="${teamName} · ${ownerTag(teamName)}" style="--owner:${ownerColor(teamName)}">
      <span class="team-code">${abbr(teamName)}</span>
      ${right}
    </div>`;
}

const ROUND_KEYS = ROUNDS.map((r) => r[0]);

// A round is "completed" once all its known matches have a winner.
function roundCompleted(key) {
  const ms = (STATE.bracket[key] || []).filter((m) => m.teamA && m.teamB);
  return ms.length > 0 && ms.every((m) => m.winner != null);
}

function renderBracket() {
  const wrap = $("#bracket");
  wrap.querySelectorAll(".connectors").forEach((s) => s.remove());
  wrap.innerHTML = "";
  const nav = $("#round-nav");
  nav.innerHTML = "";

  ROUNDS.forEach(([key, label]) => {
    const matches = STATE.bracket[key] || [];
    const col = document.createElement("section");
    col.className = "round";
    col.id = "round-" + key;
    col.dataset.round = key;
    // Completed rounds collapse by default (still scrollable to); a manual
    // toggle is remembered in collapsedRounds.
    const collapsed = key in collapsedRounds ? collapsedRounds[key] : roundCompleted(key);
    if (collapsed) col.classList.add("collapsed");

    const lbl = document.createElement("button");
    lbl.className = "round-label";
    lbl.innerHTML = `<span>${label}</span>`;
    lbl.addEventListener("click", () => toggleRound(key));
    col.appendChild(lbl);

    matches.forEach((m) => {
      const known = m.teamA && m.teamB;
      const div = document.createElement("div");
      div.className = "match" + (known ? "" : " tbd");
      const decided = m.winner != null;
      const timeLine = m.kickoff
        ? `<div class="match-time">${decided ? "✓ " : ""}${localKickoff(m.kickoff)}</div>`
        : "";
      div.innerHTML =
        timeLine +
        teamRow(m.teamA, m.probA, m, "A") +
        teamRow(m.teamB, m.probB, m, "B");
      col.appendChild(div);
    });
    wrap.appendChild(col);

    const btn = document.createElement("button");
    btn.textContent = label.replace("Round of ", "R");
    btn.dataset.round = key;
    if (key === STATE.currentRound) btn.classList.add("active");
    btn.addEventListener("click", () => {
      collapsedRounds[key] = false;            // expand if it was collapsed
      document.getElementById("round-" + key).classList.remove("collapsed");
      scrollRoundIntoView(key);
      requestAnimationFrame(drawConnectors);
    });
    nav.appendChild(btn);
  });

  wrap.querySelectorAll(".team-row[data-team]").forEach((row) => {
    row.addEventListener("click", () => openTeamSheet(row.dataset.team));
  });
}

function toggleRound(key) {
  const col = document.getElementById("round-" + key);
  collapsedRounds[key] = col.classList.toggle("collapsed");
  requestAnimationFrame(drawConnectors);
}

function scrollRoundIntoView(key) {
  const el = document.getElementById("round-" + key);
  const wrap = $("#bracket");
  if (el && wrap) wrap.scrollLeft = el.offsetLeft - wrap.offsetLeft - 8;
}

// Earliest known, undecided match (by kickoff) — the next game to be played.
function nextActiveMatch() {
  let best = null;
  for (const key of ROUND_KEYS) {
    (STATE.bracket[key] || []).forEach((m, i) => {
      if (m.teamA && m.teamB && m.winner == null) {
        const t = m.kickoff ? Date.parse(m.kickoff) : Infinity;
        if (!best || t < best.t) best = { key, i, t };
      }
    });
  }
  return best;
}

function scrollToNextGame() {
  $("#bracket").querySelectorAll(".match.next-game")
    .forEach((m) => m.classList.remove("next-game"));
  const n = nextActiveMatch();
  if (!n) return;
  const round = document.getElementById("round-" + n.key);
  const el = round.querySelectorAll(".match")[n.i];
  if (!el) return;
  el.classList.add("next-game");
  el.scrollIntoView({ block: "center", inline: "nearest" });  // vertical
  scrollRoundIntoView(n.key);                                  // horizontal
}

const SVGNS = "http://www.w3.org/2000/svg";

// Draw elbow connectors between each match and its parent (next round),
// coloured by the advancing player once a result is in.
function drawConnectors() {
  try {
    const wrap = $("#bracket");
    if (!wrap || !STATE) return;
    let svg = wrap.querySelector(".connectors");
    if (!svg) {
      svg = document.createElementNS(SVGNS, "svg");
      svg.setAttribute("class", "connectors");
      wrap.prepend(svg);
    }
    const W = wrap.scrollWidth, H = wrap.scrollHeight;
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = "";

    const lineColor = getComputedStyle(document.body)
      .getPropertyValue("--line").trim() || "#2a3340";
    const wr = wrap.getBoundingClientRect();
    const conv = (r) => ({
      left: r.left - wr.left + wrap.scrollLeft,
      right: r.right - wr.left + wrap.scrollLeft,
      midY: r.top - wr.top + wrap.scrollTop + r.height / 2,
    });

    for (let ri = 0; ri < ROUND_KEYS.length - 1; ri++) {
      const childKey = ROUND_KEYS[ri], parentKey = ROUND_KEYS[ri + 1];
      const childRound = document.getElementById("round-" + childKey);
      const parentRound = document.getElementById("round-" + parentKey);
      if (!childRound || !parentRound) continue;
      if (childRound.classList.contains("collapsed") ||
          parentRound.classList.contains("collapsed")) continue;
      const cms = childRound.querySelectorAll(".match");
      const pms = parentRound.querySelectorAll(".match");
      cms.forEach((cm, i) => {
        const pm = pms[Math.floor(i / 2)];
        if (!pm) return;
        const c = conv(cm.getBoundingClientRect());
        const p = conv(pm.getBoundingClientRect());
        const midX = (c.right + p.left) / 2;
        const m = STATE.bracket[childKey][i];
        let color = lineColor, w = 1.5, op = 0.55;
        if (m && m.winner) {
          const wt = m.winner === "A" ? m.teamA : m.teamB;
          const owner = STATE.teams[wt] && PLAYER_BY_ID[STATE.teams[wt].owner];
          if (owner) { color = owner.color; w = 3; op = 1; }
        }
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d",
          `M ${c.right} ${c.midY} H ${midX} V ${p.midY} H ${p.left}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", color);
        path.setAttribute("stroke-width", w);
        path.setAttribute("stroke-opacity", op);
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
      });
    }
  } catch (e) {
    console.warn("connectors:", e);
  }
}

function togglePlayer(id) {
  selectedPlayer = selectedPlayer === id ? null : id;
  document.body.classList.toggle("has-selection", !!selectedPlayer);
  const sl = $("#bracket").scrollLeft;
  renderStandings();
  renderBracket();
  $("#bracket").scrollLeft = sl;                 // keep scroll position
  requestAnimationFrame(drawConnectors);
}

function openTeamSheet(teamName) {
  const team = STATE.teams[teamName];
  if (!team) return;
  const owner = PLAYER_BY_ID[team.owner];
  $("#sheet-content").innerHTML = `
    <h2>${teamName}</h2>
    <p class="sub">Owned by ${owner ? owner.name : "?"} ·
      ${team.alive ? "still in" : "eliminated"} ·
      tournament win ${pct(team.winProb)}</p>
    <div class="sheet-team" style="border:none">
      <span class="dot" style="background:${owner ? owner.color : ""}"></span>
      <strong>${owner ? owner.name : "?"}'s teams</strong>
    </div>
    ${owner ? owner.teams.map((t) => {
      const tm = STATE.teams[t];
      return `<div class="sheet-team ${tm.alive ? "" : "out"}">
        <span class="team-name">${t}</span>
        <span class="team-prob">${pct(tm.winProb)}</span></div>`;
    }).join("") : ""}`;
  $("#sheet").hidden = false;
}

// ---- wiring ----
$("#standings-toggle").addEventListener("click", () =>
  $("#standings").classList.toggle("open"));
$("#sheet-close").addEventListener("click", () => ($("#sheet").hidden = true));
$("#sheet").addEventListener("click", (e) => {
  if (e.target.id === "sheet") $("#sheet").hidden = true;
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawConnectors, 150);
});

load().catch((err) => {
  document.getElementById("bracket").innerHTML =
    `<p style="color:#f66;padding:16px">Could not load data: ${err.message}</p>`;
});
