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
let focusRound = null;      // round to scroll to (from a shared link / nav)

// Initial view/player/round come from the URL (shared links) first, then
// localStorage, then a width default. Keeps shared links reproducible.
const URL_PARAMS = new URLSearchParams(location.search);
const VIEWS = ["funnel", "bracket", "fixtures"];
let viewMode = VIEWS.includes(URL_PARAMS.get("view")) ? URL_PARAMS.get("view")
  : (localStorage.getItem("wc-view") || (window.innerWidth < 820 ? "funnel" : "bracket"));

function syncURL() {
  const p = new URLSearchParams();
  p.set("view", viewMode);
  if (selectedPlayer) p.set("player", selectedPlayer);
  if (focusRound) p.set("round", focusRound);
  history.replaceState(null, "", location.pathname + "?" + p.toString());
}

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

// A match is "live" from kickoff until ~135 min later (covers ET) if undecided.
function isLive(m) {
  if (!m.kickoff || m.winner != null) return false;
  const ko = Date.parse(m.kickoff);
  if (isNaN(ko)) return false;
  const mins = (Date.now() - ko) / 60000;
  return mins >= 0 && mins <= 135;
}

// Header line on a match card: LIVE while in play, kickoff otherwise (✓ once done).
function matchHeader(m) {
  if (!m.kickoff) return "";
  if (isLive(m)) {
    return `<div class="match-time live"><span class="live-dot"></span>LIVE · ${localKickoff(m.kickoff)}</div>`;
  }
  const decided = m.winner != null;
  return `<div class="match-time">${decided ? "✓ " : ""}${localKickoff(m.kickoff)}</div>`;
}

// This team's goals, from the stored "a–b" score (teamA–teamB).
function teamGoals(match, side) {
  if (!match.score) return null;
  const parts = match.score.split("–");
  const g = side === "A" ? parts[0] : parts[1];
  return g != null ? g.trim() : null;
}

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

  // Apply player + round from a shared link.
  const pid = URL_PARAMS.get("player");
  if (pid && PLAYER_BY_ID[pid]) {
    selectedPlayer = pid;
    document.body.classList.add("has-selection");
  }
  const r = URL_PARAMS.get("round");
  if (r && ROUND_KEYS.includes(r)) focusRound = r;

  render();
  renderSelChip();
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
  renderTree();
  $("#updated-at").textContent = new Date(STATE.updatedAt).toLocaleString(undefined, {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  $("#alive-count").textContent = aliveCount();
  renderSourceBadge();
  renderChampion();
  updateViewSeg();
  // Layout-dependent passes run after the browser lays the tree out.
  requestAnimationFrame(() => {
    if (viewMode === "bracket") drawConnectors();
    scrollToFocusOrNext();
  });
}

function renderTree() {
  const wrap = $("#bracket");
  wrap.classList.remove("as-funnel", "as-fixtures");
  if (viewMode === "funnel") {
    wrap.classList.add("as-funnel");
    renderFunnel();
  } else if (viewMode === "fixtures") {
    wrap.classList.add("as-fixtures");
    renderFixtures();
  } else {
    renderBracket();
  }
  $("#round-nav").style.display = viewMode === "fixtures" ? "none" : "";
}

function setView(mode) {
  viewMode = mode;
  localStorage.setItem("wc-view", mode);
  syncURL();
  renderTree();
  updateViewSeg();
  requestAnimationFrame(() => {
    if (viewMode === "bracket") drawConnectors();
    scrollToFocusOrNext();
  });
}

function updateViewSeg() {
  document.querySelectorAll("#view-seg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === viewMode));
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
    li.className = "standings-row" + (aliveTeams === 0 ? " eliminated" : "") +
      (selectedPlayer === p.id ? " selected" : "");
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      ${rankMove(p, i + 1)}
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

// Stock-exchange ▲/▼ since the last match result (prevRank set by the scraper).
function rankMove(p, currentRank) {
  if (p.prevRank == null) return `<span class="rank-move"></span>`;
  const delta = p.prevRank - currentRank;
  if (delta > 0) return `<span class="rank-move up" title="up ${delta}">▲${delta}</span>`;
  if (delta < 0) return `<span class="rank-move down" title="down ${-delta}">▼${-delta}</span>`;
  return `<span class="rank-move flat">–</span>`;
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

function teamRow(teamName, prob, match, side, full) {
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
  const goals = teamGoals(match, side);
  let right = "";
  if (decided && goals != null) {
    right = `<span class="team-goals">${goals}</span>`;
  } else if (decided && isWinner) {
    right = `<span class="adv" aria-label="advances">▸</span>`;
  } else if (showProb) {
    right = `<span class="team-prob">${pct(prob)}</span>`;
  }
  const codeOrName = full
    ? `<span class="team-code">${abbr(teamName)}</span><span class="team-full">${teamName}</span>`
    : `<span class="team-code">${abbr(teamName)}</span>`;
  const own = `<span class="team-own">${ownerTag(teamName)}</span>`;
  return `
    <div class="team-row${cls}${sel}" data-owner="${owner || ""}" data-team="${teamName}"
         title="${teamName} · ${ownerTag(teamName)}" style="--owner:${ownerColor(teamName)}">
      <span class="team-label">${codeOrName}${own}</span>
      ${right}
    </div>`;
}

const ROUND_KEYS = ROUNDS.map((r) => r[0]);
const NAV_LABEL = { R32: "R32", R16: "R16", QF: "QF", SF: "SF", F: "Final" };

// A round is "completed" once all its known matches have a winner.
function roundCompleted(key) {
  const ms = (STATE.bracket[key] || []).filter((m) => m.teamA && m.teamB);
  return ms.length > 0 && ms.every((m) => m.winner != null);
}

// A slim two-tone bar showing the win-probability split (owner colours).
function probBar(m) {
  if (!(m.teamA && m.teamB)) return "";
  const ca = ownerColor(m.teamA), cb = ownerColor(m.teamB);
  if (m.winner) {
    const c = m.winner === "A" ? ca : cb;
    return `<div class="prob-bar"><span style="width:100%;background:${c}"></span></div>`;
  }
  const pa = m.probA != null ? m.probA : 0.5;
  return `<div class="prob-bar">
    <span style="width:${(pa * 100).toFixed(1)}%;background:${ca}"></span>
    <span style="width:${((1 - pa) * 100).toFixed(1)}%;background:${cb}"></span></div>`;
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

    matches.forEach((m, i) => {
      const known = m.teamA && m.teamB;
      const div = document.createElement("div");
      div.className = "match" + (known ? "" : " tbd");
      div.dataset.round = key;
      div.dataset.mi = i;
      div.innerHTML =
        matchHeader(m) +
        teamRow(m.teamA, m.probA, m, "A") +
        teamRow(m.teamB, m.probB, m, "B") +
        probBar(m);
      col.appendChild(div);
    });
    wrap.appendChild(col);

    const btn = document.createElement("button");
    btn.textContent = NAV_LABEL[key];
    btn.dataset.round = key;
    if (key === STATE.currentRound) btn.classList.add("active");
    btn.addEventListener("click", () => navTo(key));
    nav.appendChild(btn);
  });

  wrap.querySelectorAll(".team-row[data-team]").forEach((row) => {
    row.addEventListener("click", () => openTeamSheet(row.dataset.team));
  });
}

function toggleRound(key) {
  const el = document.getElementById("round-" + key);
  const cls = viewMode === "funnel" ? "fcollapsed" : "collapsed";
  collapsedRounds[key] = el.classList.toggle(cls);
  if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
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

function markNextGame() {
  const wrap = $("#bracket");
  wrap.querySelectorAll(".match.next-game").forEach((m) => m.classList.remove("next-game"));
  const n = nextActiveMatch();
  if (!n) return null;
  const el = wrap.querySelector(`.match[data-round="${n.key}"][data-mi="${n.i}"]`);
  if (!el) return null;
  el.classList.add("next-game");
  return el;
}

function scrollToNextGame() {
  const el = markNextGame();
  if (el) el.scrollIntoView({ block: "center", inline: "center" });
}

// On (re)render: highlight the next game, then scroll to the shared/nav round
// if there is one, otherwise to the next game.
function scrollToFocusOrNext() {
  const ng = markNextGame();
  if (focusRound) {
    const el = document.getElementById("round-" + focusRound);
    if (el) {
      collapsedRounds[focusRound] = false;
      el.classList.remove("fcollapsed", "collapsed");
      const target = el.querySelector(".match") || el;
      target.scrollIntoView({ block: viewMode === "funnel" ? "start" : "center", inline: "center" });
      if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
      return;
    }
  }
  if (ng) ng.scrollIntoView({ block: "center", inline: "center" });
}

// Round-nav / shared-link target: focus a round and record it in the URL.
function navTo(key) {
  focusRound = key;
  collapsedRounds[key] = false;
  const el = document.getElementById("round-" + key);
  if (el) {
    el.classList.remove("fcollapsed", "collapsed");
    const target = el.querySelector(".match.next-game") || el.querySelector(".match") || el;
    target.scrollIntoView({ behavior: "smooth", block: viewMode === "funnel" ? "start" : "center", inline: "center" });
    if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
  }
  syncURL();
}

function championName() {
  const f = (STATE.bracket.F || [])[0];
  if (!f) return null;
  return f.winner === "A" ? f.teamA : f.winner === "B" ? f.teamB : null;
}

// Vertical "Road to the Final": rounds stacked top->bottom, narrowing to the
// trophy. Mobile-native (scroll down). No SVG connectors here — the funnel
// shape + owner stripes carry it.
const FUNNEL_WIDTH = { R32: 86, R16: 76, QF: 66, SF: 57, F: 50 };

function owns(m, pid) {
  return STATE.teams[m.teamA]?.owner === pid || STATE.teams[m.teamB]?.owner === pid;
}

function renderFunnel() {
  const wrap = $("#bracket");
  wrap.querySelectorAll(".connectors").forEach((s) => s.remove());
  wrap.innerHTML = "";
  const nav = $("#round-nav");
  nav.innerHTML = "";

  ROUNDS.forEach(([key, label]) => {
    const all = STATE.bracket[key] || [];
    // D — journey filter: when a player is selected, show only their matches.
    const matches = selectedPlayer ? all.filter((m) => owns(m, selectedPlayer)) : all;
    const known = matches.filter((m) => m.teamA && m.teamB);
    const hasLive = matches.some((m) => m.teamA && m.teamB && m.winner == null);
    // B — collapse rounds with no live game yet (or completed/past), unless the
    // user expanded them. Rounds with a live, undecided game stay open.
    const collapsed = key in collapsedRounds ? collapsedRounds[key] : !hasLive;

    const sec = document.createElement("section");
    sec.className = "fround" + (collapsed ? " fcollapsed" : "");
    sec.id = "round-" + key;
    sec.dataset.round = key;
    sec.style.setProperty("--fw", FUNNEL_WIDTH[key] + "%");
    const count = known.length ? ` · ${known.length}` : (matches.length ? " · TBD" : "");
    const head = document.createElement("button");
    head.className = "fround-head";
    head.innerHTML = `<span>${label}${count}</span><i class="chev">⌄</i>`;
    head.addEventListener("click", () => toggleRound(key));
    sec.appendChild(head);

    const box = document.createElement("div");
    box.className = "fmatches";
    all.forEach((m, i) => {
      if (selectedPlayer && !owns(m, selectedPlayer)) return;
      const div = document.createElement("div");
      div.className = "match" + (m.teamA && m.teamB ? "" : " tbd");
      div.dataset.round = key;
      div.dataset.mi = i;
      div.innerHTML =
        matchHeader(m) +
        teamRow(m.teamA, m.probA, m, "A", true) +
        teamRow(m.teamB, m.probB, m, "B", true) +
        probBar(m);
      box.appendChild(div);
    });
    sec.appendChild(box);
    wrap.appendChild(sec);

    const btn = document.createElement("button");
    btn.textContent = NAV_LABEL[key];
    btn.dataset.round = key;
    if (key === STATE.currentRound) btn.classList.add("active");
    btn.addEventListener("click", () => navTo(key));
    nav.appendChild(btn);
  });

  const champ = championName();
  const owner = champ && PLAYER_BY_ID[STATE.teams[champ]?.owner];
  const tro = document.createElement("div");
  tro.className = "ftrophy";
  tro.innerHTML = champ
    ? `🏆<div class="champ-name" style="color:${owner ? owner.color : ""}">${champ}</div>
       <div class="champ-sub">${owner ? owner.name + " wins the draw!" : ""}</div>`
    : `🏆<div class="champ-sub">Road to the Final</div>`;
  wrap.appendChild(tro);

  wrap.querySelectorAll(".team-row[data-team]").forEach((row) => {
    row.addEventListener("click", () => openTeamSheet(row.dataset.team));
  });
}

// "Today" / "Tomorrow" / "Sat 4 Jul" in the viewer's timezone.
function dateLabel(iso) {
  if (!iso) return "Date TBD";
  const d = new Date(iso);
  if (isNaN(d)) return "Date TBD";
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// C — Fixtures: every known matchup in date order, grouped by day.
function renderFixtures() {
  const wrap = $("#bracket");
  wrap.querySelectorAll(".connectors").forEach((s) => s.remove());
  wrap.innerHTML = "";
  $("#round-nav").innerHTML = "";

  const list = [];
  ROUND_KEYS.forEach((key) => {
    (STATE.bracket[key] || []).forEach((m, i) => {
      if (m.teamA && m.teamB && (!selectedPlayer || owns(m, selectedPlayer))) {
        list.push({ m, key, i });
      }
    });
  });
  list.sort((a, b) =>
    (Date.parse(a.m.kickoff) || Infinity) - (Date.parse(b.m.kickoff) || Infinity));

  if (!list.length) {
    wrap.innerHTML = `<p class="fx-empty">No fixtures yet${selectedPlayer ? " for this player" : ""}.</p>`;
    return;
  }

  let lastDate = null;
  list.forEach(({ m, key, i }) => {
    const dl = dateLabel(m.kickoff);
    if (dl !== lastDate) {
      lastDate = dl;
      const h = document.createElement("div");
      h.className = "fx-date";
      h.textContent = dl;
      wrap.appendChild(h);
    }
    const div = document.createElement("div");
    div.className = "match";
    div.dataset.round = key;
    div.dataset.mi = i;
    div.innerHTML =
      matchHeader(m) +
      teamRow(m.teamA, m.probA, m, "A", true) +
      teamRow(m.teamB, m.probB, m, "B", true) +
      probBar(m);
    wrap.appendChild(div);
  });

  wrap.querySelectorAll(".team-row[data-team]").forEach((row) => {
    row.addEventListener("click", () => openTeamSheet(row.dataset.team));
  });
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
        } else if (m && m.teamA && m.teamB) {
          // Same owner on both sides -> that player advances no matter what.
          const oa = STATE.teams[m.teamA]?.owner, ob = STATE.teams[m.teamB]?.owner;
          if (oa && oa === ob && PLAYER_BY_ID[oa]) {
            color = PLAYER_BY_ID[oa].color; w = 2.5; op = 0.85;
          }
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
  if (selectedPlayer) $("#standings").classList.remove("open");  // get out of the way (mobile)
  syncURL();
  renderSelChip();
  const sl = $("#bracket").scrollLeft;
  renderStandings();
  renderTree();
  $("#bracket").scrollLeft = sl;                 // keep scroll position
  markNextGame();                                // keep the highlight after re-render
  if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
}

function renderSelChip() {
  const chip = $("#sel-chip");
  if (selectedPlayer && PLAYER_BY_ID[selectedPlayer]) {
    const p = PLAYER_BY_ID[selectedPlayer];
    chip.hidden = false;
    chip.innerHTML =
      `<span class="dot" style="background:${p.color}"></span>${p.name}<span class="x">✕</span>`;
  } else {
    chip.hidden = true;
  }
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
document.querySelectorAll("#view-seg button").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view)));
$("#sel-chip").addEventListener("click", () => {
  if (selectedPlayer) togglePlayer(selectedPlayer);   // clears the filter
});
$("#sheet-close").addEventListener("click", () => ($("#sheet").hidden = true));
$("#sheet").addEventListener("click", (e) => {
  if (e.target.id === "sheet") $("#sheet").hidden = true;
});

// Sticky controls sit just below the mobile standings bar; 0 on desktop (the
// standings is a left sidebar there).
function setCtrlTop() {
  const mobile = window.innerWidth < 820;
  const h = mobile ? ($("#standings-toggle")?.offsetHeight || 46) : 0;
  document.documentElement.style.setProperty("--ctrl-top", h + "px");
}
setCtrlTop();

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { setCtrlTop(); drawConnectors(); }, 150);
});

// Live auto-refresh: re-pull state.json periodically and re-render in place (no
// scroll jump) when the data has actually changed — so scores/standings update
// during games without a manual reload.
async function refreshData() {
  if (document.hidden || !STATE) return;
  try {
    const res = await fetch("data/state.json?t=" + Date.now());
    if (!res.ok) return;
    const s = await res.json();
    if (!s.updatedAt || s.updatedAt === STATE.updatedAt) return;
    STATE = s;
    PLAYER_BY_ID = Object.fromEntries(s.players.map((p) => [p.id, p]));
    const sl = $("#bracket").scrollLeft;
    renderStandings();
    renderTree();
    $("#bracket").scrollLeft = sl;
    $("#updated-at").textContent = new Date(STATE.updatedAt).toLocaleString(undefined, {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
    $("#alive-count").textContent = aliveCount();
    renderSourceBadge();
    renderChampion();
    markNextGame();
    if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
  } catch (e) { /* offline / transient — ignore */ }
}
setInterval(refreshData, 90000);

// Cheap local tick: only re-render when a game starts/ends being LIVE.
let lastLiveKey = "";
setInterval(() => {
  if (document.hidden || !STATE) return;
  const live = [];
  ROUND_KEYS.forEach((k) =>
    (STATE.bracket[k] || []).forEach((m, i) => { if (isLive(m)) live.push(k + i); }));
  const key = live.join(",");
  if (key !== lastLiveKey) {
    lastLiveKey = key;
    const sl = $("#bracket").scrollLeft;
    renderTree();
    $("#bracket").scrollLeft = sl;
    markNextGame();
    if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
  }
}, 60000);

load().catch((err) => {
  document.getElementById("bracket").innerHTML =
    `<p style="color:#f66;padding:16px">Could not load data: ${err.message}</p>`;
});
