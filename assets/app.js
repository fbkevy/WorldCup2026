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

// Must match the ?v= on the script tag in index.html. When a newer version is
// deployed, open pages auto-reload to pick up new code (see checkForUpdate).
const APP_VERSION = 21;

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

// ---- Live scores from a free, no-key, CORS-open source (worldcup26.ir) ----
// Real-time in-match scores + minute, polled client-side. Final results still
// come from the reliable Odds API bot; this is a best-effort live overlay.
const LIVE_NAME_MAP = {
  "Bosnia and Herzegovina": "Bosnia", "Czech Republic": "Czechia",
  "Democratic Republic of the Congo": "DR Congo", "South Korea": "Korea Republic",
  "Turkey": "Türkiye", "United States": "USA",
};
const liveCanon = (n) => LIVE_NAME_MAP[n] || n;

// Goal scorers come as a Postgres array literal: {"Kylian Mbappé 45'","..."}.
function parseScorers(s) {
  if (!s || s === "null") return [];
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1]);
  if (!out.length) {                       // unquoted fallback
    s.replace(/[{}]/g, "").split(",").forEach((x) => { if (x.trim()) out.push(x.trim()); });
  }
  return out;
}

// "Kylian Mbappé 45'" / "Mbappé 74'" -> compact "Mbappé 45', 74'", grouping a
// player's goals. Surname only to save space on mobile.
function fmtScorers(list) {
  const order = [], mins = {};
  list.forEach((e) => {
    const mt = String(e).match(/^(.*?)[\s ]+(\d+\+?\d*)'?\s*$/);
    const name = mt ? mt[1].trim() : String(e).trim();
    const min = mt ? mt[2] + "'" : "";
    if (!(name in mins)) { mins[name] = []; order.push(name); }
    if (min) mins[name].push(min);
  });
  const surname = (n) => { const p = n.split(/\s+/); return p[p.length - 1]; };
  return order.map((n) => surname(n) + (mins[n].length ? " " + mins[n].join(", ") : "")).join(" · ");
}
let LIVE_SCORES = {};   // "TeamA|TeamB" (sorted) -> {h,a,hs,as,minute,minNum,finished}
let LIVE_FETCHED_AT = 0; // when LIVE_SCORES was last refreshed (for minute interpolation)

async function fetchLiveScores() {
  try {
    const res = await fetch("https://worldcup26.ir/get/games", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const map = {};
    for (const g of (data.games || [])) {
      const h = liveCanon(g.home_team_name_en), a = liveCanon(g.away_team_name_en);
      if (!h || !a) continue;
      const te = String(g.time_elapsed || "").toLowerCase();
      const finished = te === "finished" || String(g.finished).toUpperCase() === "TRUE";
      const notstarted = te === "notstarted" || te === "";
      const live = !finished && !notstarted;
      const mn = parseInt(te, 10);   // "45+2" -> 45, "ht" -> NaN
      const pi = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
      map[[h, a].sort().join("|")] = {
        h, a, hs: g.home_score, as: g.away_score,
        minute: live ? g.time_elapsed : null,
        minNum: live && Number.isFinite(mn) ? mn : null, finished,
        hsc: parseScorers(g.home_scorers), asc: parseScorers(g.away_scorers),
        hp: pi(g.home_penalty_score), ap: pi(g.away_penalty_score),  // shootout tally
      };
    }
    LIVE_SCORES = map;
    LIVE_FETCHED_AT = Date.now();
  } catch (e) { /* source down — fall back to time-based live */ }
}

// The feed only flags a game as "live" (no numeric minute), so estimate the
// match clock from our own kickoff time. Because kickoff is a fixed anchor (it
// can't self-correct like a feed minute would), we must bake in the wall time
// that isn't played minutes: first-half stoppage (where a cooling/hydration
// break lands), the halftime interval, and second-half stoppage. The official
// clock keeps running through cooling breaks, so that time surfaces as longer
// stoppage (45+/90+) rather than a pause — only halftime freezes the clock.
const ST1 = 5;   // 1st-half stoppage allowance (incl. ~3' cooling break)
const HT = 15;   // halftime interval (clock frozen)
const H2 = 45 + ST1 + HT;   // wall minutes from KO until the 2nd half kicks off
function estMatchClock(m) {
  if (!m.kickoff) return null;
  const e = Math.floor((Date.now() - Date.parse(m.kickoff)) / 60000);  // wall min since KO
  if (e < 0) return null;
  if (e < 45) return String(e);                       // first half
  if (e < 45 + ST1) return "45+" + (e - 45);          // 1st-half stoppage / cooling break
  if (e < H2) return "HT";                             // halftime (frozen)
  const mm = 46 + (e - H2);                            // second-half running minute
  if (mm <= 90) return String(mm);
  return "90+" + Math.min(mm - 90, 10);               // 2nd-half stoppage, cap +10
}

// If a numeric feed minute is ever available, anchor to it and add elapsed real
// time since the fetch (same caps).
function liveMinuteFromFeed(base) {
  const extra = Math.max(0, Math.floor((Date.now() - LIVE_FETCHED_AT) / 60000));
  return String(Math.min(base + extra, base < 45 ? 45 : 100));
}

// Format a clock value for display: append ' to numeric minutes ("63" -> "63'",
// "45+2" -> "45+2'") but leave word labels alone ("HT").
const fmtMin = (v) => v == null ? "" : (/\d$/.test(String(v)) ? `${v}'` : `${v}`);

// Live info for one of our matches, oriented to teamA/teamB.
function liveFor(m) {
  if (!m.teamA || !m.teamB) return null;
  const e = LIVE_SCORES[[m.teamA, m.teamB].sort().join("|")];
  if (!e) return null;
  const aHome = m.teamA === e.h;
  const aScore = aHome ? e.hs : e.as;
  const bScore = aHome ? e.as : e.hs;
  const minute = e.minNum != null ? liveMinuteFromFeed(e.minNum) : estMatchClock(m);
  return {
    minute, finished: e.finished, aScore, bScore,
    aScorers: aHome ? e.hsc : e.asc, bScorers: aHome ? e.asc : e.hsc,
    aPen: aHome ? e.hp : e.ap, bPen: aHome ? e.ap : e.hp,
  };
}

// A match is "live" if the feed says it's in play, or (fallback) within the
// kickoff window and not yet resolved.
function isLive(m) {
  if (m.winner != null) return false;
  const ls = liveFor(m);
  if (ls) {
    if (ls.finished) return false;
    if (ls.minute != null) return true;
  }
  if (!m.kickoff) return false;
  const mins = (Date.now() - Date.parse(m.kickoff)) / 60000;
  return mins >= 0 && mins <= 135;
}

// Header line on a match card: live score+minute while in play, kickoff otherwise.
function matchHeader(m) {
  if (isLive(m)) {
    const ls = liveFor(m);
    const sc = ls && ls.aScore != null ? ` ${ls.aScore}–${ls.bScore}` : "";
    const min = ls && ls.minute != null ? ` ${fmtMin(ls.minute)}` : "";
    return `<div class="match-time live"><span class="live-dot"></span>LIVE${min}${sc}</div>`;
  }
  if (!m.kickoff) return "";
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

let HISTORY = null;

async function load() {
  const res = await fetch("data/state.json?t=" + Date.now());
  STATE = await res.json();
  PLAYER_BY_ID = Object.fromEntries(STATE.players.map((p) => [p.id, p]));
  fetch("data/history.json?t=" + Date.now())
    .then((r) => (r.ok ? r.json() : null)).then((h) => { HISTORY = h; }).catch(() => {});

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
  renderLiveStrip();
  renderHighlights();
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
  if (celebratedFor !== champ) { celebratedFor = champ; fireConfetti(owner ? owner.color : "#ffd43b"); }
}

// ---- Share (#1) ----
async function shareView() {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: "World Cup Draw 2026", url });
    else { await navigator.clipboard.writeText(url); toast("Link copied"); }
  } catch (e) { /* user cancelled / not allowed */ }
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---- Live-now strip (#5) ----
// "Now & Next": the live game (prominent, with live score) + the next upcoming
// game (compact). Tap either to scroll the bracket to it.
function nnCard(x, kind) {
  const { m, k, i } = x;
  const live = isLive(m);
  const ls = liveFor(m);
  const label = kind === "now"
    ? (live ? `<span class="live-dot"></span>LIVE${ls && ls.minute != null ? ` ${fmtMin(ls.minute)}` : ""}` : "NOW")
    : `NEXT · ${localKickoff(m.kickoff)}`;
  const side = (t, s) => {
    let val = "", pen = "";
    if (live && ls && ls.aScore != null) {
      val = s === "A" ? ls.aScore : ls.bScore;
      const pv = s === "A" ? ls.aPen : ls.bPen;
      if (pv != null) pen = `<span class="nn-pen">(${pv})</span>`;
    } else if (kind === "next") val = pct(s === "A" ? m.probA : m.probB);
    const sc = live && ls ? fmtScorers((s === "A" ? ls.aScorers : ls.bScorers) || []) : "";
    const goals = sc ? `<div class="nn-goals">⚽ ${sc}</div>` : "";
    return `<div class="nn-team"><span class="dot" style="background:${ownerColor(t)}"></span>` +
      `<span class="nn-code">${abbr(t)}</span><span class="nn-own">${ownerTag(t)}</span>` +
      `<span class="nn-score">${val}${pen}</span></div>${goals}`;
  };
  return `<button class="nn-card ${kind}${live ? " live" : ""}" data-round="${k}" data-mi="${i}">` +
    `<div class="nn-label">${label}</div>${side(m.teamA, "A")}${side(m.teamB, "B")}</button>`;
}

function renderLiveStrip() {   // now a "Now & Next" strip
  const el = $("#live-strip");
  const known = [];
  ROUND_KEYS.forEach((k) => (STATE.bracket[k] || []).forEach((m, i) => {
    if (m.teamA && m.teamB && m.winner == null) known.push({ m, k, i });
  }));
  known.sort((a, b) => (Date.parse(a.m.kickoff) || Infinity) - (Date.parse(b.m.kickoff) || Infinity));
  const now = known.find((x) => isLive(x.m));
  const next = known.find((x) => x !== now);
  if (!now && !next) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = (now ? nnCard(now, "now") : "") + (next ? nnCard(next, "next") : "");
  el.querySelectorAll(".nn-card").forEach((c) =>
    c.addEventListener("click", () => scrollToMatch(c.dataset.round, +c.dataset.mi)));
}

// Scroll the bracket/funnel to a specific match and flash it.
function scrollToMatch(round, mi) {
  focusRound = round;
  collapsedRounds[round] = false;
  renderTree();
  syncURL();
  requestAnimationFrame(() => {
    if (viewMode === "bracket") drawConnectors();
    const t = $("#bracket").querySelector(`.match[data-round="${round}"][data-mi="${mi}"]`);
    if (t) {
      t.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      t.classList.add("flash");
      setTimeout(() => t.classList.remove("flash"), 1200);
    }
  });
}

// ---- Highlights ticker: biggest riser + latest upset (#3) ----
function renderHighlights() {
  const el = $("#highlights");
  const chips = [];

  const ranked = [...STATE.players].map((p) => ({ p, prob: playerProb(p) }))
    .sort((a, b) => b.prob - a.prob);
  let best = null;
  ranked.forEach(({ p }, i) => {
    if (p.prevRank != null) {
      const d = p.prevRank - (i + 1);
      if (d > 0 && (!best || d > best.d)) best = { name: p.name, color: p.color, d };
    }
  });
  if (best) chips.push(`<span class="hl-chip"><i class="up">▲</i> <b style="color:${best.color}">${best.name}</b> up ${best.d}</span>`);

  // Latest upset: a decided match the underdog won (winning side prob < 0.45).
  let upset = null;
  ROUND_KEYS.forEach((k) => (STATE.bracket[k] || []).forEach((m) => {
    if (m.winner && m.score) {
      const wp = m.winner === "A" ? m.probA : m.probB;
      const wt = m.winner === "A" ? m.teamA : m.teamB;
      const lt = m.winner === "A" ? m.teamB : m.teamA;
      const ko = Date.parse(m.kickoff) || 0;
      if (wp != null && wp < 0.45 && (!upset || ko > upset.ko)) upset = { wt, lt, score: m.score, ko };
    }
  }));
  if (upset) chips.push(`<span class="hl-chip">⚡ Upset: <b>${upset.wt}</b> beat ${upset.lt} ${upset.score}</span>`);

  if (!chips.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = chips.join("");
}

// ---- Confetti (#2) ----
let celebratedFor = null;
function fireConfetti(color) {
  const cv = $("#confetti");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  cv.width = window.innerWidth; cv.height = window.innerHeight;
  const colors = [color, "#ffd43b", "#2f9e44", "#1c7ed6", "#e6394a", "#7048e8"];
  const bits = Array.from({ length: 160 }, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5,
    r: 4 + Math.random() * 5, c: colors[(Math.random() * colors.length) | 0],
    vy: 2 + Math.random() * 4, vx: -2 + Math.random() * 4, rot: Math.random() * 6,
  }));
  const start = Date.now();
  (function frame() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    bits.forEach((b) => {
      b.y += b.vy; b.x += b.vx; b.rot += 0.1;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      ctx.fillStyle = b.c; ctx.fillRect(-b.r / 2, -b.r / 2, b.r, b.r * 1.6); ctx.restore();
    });
    if (Date.now() - start < 4000) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
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

// Candidate teams for a future slot, weighted by their projected chance of
// *winning* that match (i.e. advancing out of it). That's their reach into the
// NEXT round, so the weights sum to 1 across the slot — exactly one team
// advances. Slot k in round R is fed by R32 matches [k*span, (k+1)*span).
const NEXT_ROUND = { R32: "R16", R16: "QF", QF: "SF", SF: "F", F: "W" };
function slotProjection(roundKey, k) {
  const level = ROUND_KEYS.indexOf(roundKey);   // R32=0, R16=1, ...
  if (level <= 0) return [];
  const span = 1 << level;
  const nextKey = NEXT_ROUND[roundKey];
  const r32 = STATE.bracket["R32"] || [];
  const seen = new Set();
  const cands = [];
  for (let i = k * span; i < (k + 1) * span && i < r32.length; i++) {
    for (const t of [r32[i].teamA, r32[i].teamB]) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const w = STATE.teams[t]?.reach?.[nextKey] || 0;
      if (w > 0) cands.push({ t, w });
    }
  }
  cands.sort((a, b) => b.w - a.w);
  return cands;
}

// Owner-coloured segmented bar for a future bracket slot + named top contenders.
function projBar(roundKey, k) {
  const cands = slotProjection(roundKey, k);
  if (cands.length < 2) return "";
  // Weights are each team's chance of winning this match, so they sum to ~1.
  // Bar widths are normalised to fill; labels show the true % (top few, so the
  // shown numbers sum to ≤100 — the omitted long tail makes up the rest).
  const total = cands.reduce((s, c) => s + c.w, 0) || 1;
  const segs = cands.map((c) =>
    `<span style="width:${(c.w / total * 100).toFixed(1)}%;background:${ownerColor(c.t)}"
       title="${c.t} · ${ownerTag(c.t)} · ${pct(c.w)} to advance"></span>`).join("");
  const top = cands.slice(0, 3).map((c) =>
    `<span class="proj-name" data-team="${c.t}"><span class="dot" style="background:${ownerColor(c.t)}"></span>` +
    `${abbr(c.t)} <b>${pct(c.w)}</b></span>`).join("");
  return `<div class="proj"><div class="prob-bar proj-bar">${segs}</div>` +
         `<div class="proj-names">${top}</div></div>`;
}

// Goal scorers under a live match card (feed gives names + minutes).
function liveGoals(m) {
  if (!isLive(m)) return "";
  const ls = liveFor(m);
  if (!ls) return "";
  const a = fmtScorers(ls.aScorers || []), b = fmtScorers(ls.bScorers || []);
  if (!a && !b) return "";
  const row = (t, s) => s
    ? `<div class="mg-row"><span class="mg-code">${abbr(t)}</span><span class="mg-list">⚽ ${s}</span></div>`
    : "";
  return `<div class="match-goals">${row(m.teamA, a)}${row(m.teamB, b)}</div>`;
}

// Inner HTML for one match card — a real matchup, or a projected future slot.
function matchInner(m, key, i, full) {
  if (m.teamA && m.teamB) {
    return matchHeader(m) +
      teamRow(m.teamA, m.probA, m, "A", full) +
      teamRow(m.teamB, m.probB, m, "B", full) +
      probBar(m) + liveGoals(m);
  }
  const pb = projBar(key, i);
  if (pb) {
    // No "Projected" caption (clearly is); show the kickoff time when we have
    // one (only set once the matchup firms up), otherwise no header.
    const head = m.kickoff ? `<div class="proj-head">${localKickoff(m.kickoff)}</div>` : "";
    return head + pb;
  }
  return teamRow(m.teamA, m.probA, m, "A", full) +
         teamRow(m.teamB, m.probB, m, "B", full);
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

    // Matches live in their own centred body so the round label doesn't skew
    // the vertical distribution (keeps the final near centre, not 70% down).
    const body = document.createElement("div");
    body.className = "round-body";
    matches.forEach((m, i) => {
      const known = m.teamA && m.teamB;
      const div = document.createElement("div");
      div.className = "match" + (known ? "" : " tbd");
      div.dataset.round = key;
      div.dataset.mi = i;
      div.innerHTML = matchInner(m, key, i, false);
      body.appendChild(div);
    });
    col.appendChild(body);
    wrap.appendChild(col);

    const btn = document.createElement("button");
    btn.textContent = NAV_LABEL[key];
    btn.dataset.round = key;
    if (key === STATE.currentRound) btn.classList.add("active");
    btn.addEventListener("click", () => navTo(key));
    nav.appendChild(btn);
  });

  wrap.querySelectorAll("[data-team]").forEach((row) => {
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
      div.innerHTML = matchInner(m, key, i, true);
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

  wrap.querySelectorAll("[data-team]").forEach((row) => {
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

  wrap.querySelectorAll("[data-team]").forEach((row) => {
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

// Tiny win-% history chart for a player (from data/history.json).
function sparkline(pid, color) {
  if (!HISTORY || !HISTORY.snapshots || HISTORY.snapshots.length < 2) return "";
  const series = HISTORY.snapshots.map((s) => s.probs[pid]).filter((v) => v != null);
  if (series.length < 2) return "";
  const w = 260, h = 54, pad = 5;
  const max = Math.max(...series), min = Math.min(...series), range = (max - min) || 1;
  const pts = series.map((v, i) => {
    const x = pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const first = series[0], last = series[series.length - 1], up = last >= first;
  return `<div class="spark">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/></svg>
    <div class="spark-cap">win% over time
      <span style="color:${up ? "#2ee59d" : "#ff6b6b"}">${up ? "▲" : "▼"} now ${pct(last)}</span></div>
  </div>`;
}

function deepestStageLabel(ownerId) {
  let deepest = -1;
  ROUND_KEYS.forEach((k, ri) => (STATE.bracket[k] || []).forEach((m) => {
    [m.teamA, m.teamB].forEach((t) => {
      if (t && STATE.teams[t]?.owner === ownerId) deepest = Math.max(deepest, ri);
    });
  }));
  return deepest >= 0 ? ROUNDS[deepest][1] : "Group stage";
}

function openTeamSheet(teamName) {
  const team = STATE.teams[teamName];
  if (!team) return;
  const owner = PLAYER_BY_ID[team.owner];
  if (!owner) { $("#sheet").hidden = false; return; }

  const ranked = [...STATE.players].map((p) => ({ p, prob: playerProb(p) }))
    .sort((a, b) => b.prob - a.prob);
  const rank = ranked.findIndex((r) => r.p.id === owner.id) + 1;
  const combined = playerProb(owner);
  const aliveTeams = owner.teams.filter((t) => STATE.teams[t]?.alive);
  const outTeams = owner.teams.filter((t) => !STATE.teams[t]?.alive);
  const best = [...aliveTeams].sort((a, b) => STATE.teams[b].winProb - STATE.teams[a].winProb)[0];

  const teamLine = (t) => {
    const tm = STATE.teams[t];
    const o = PLAYER_BY_ID[tm.owner];
    return `<div class="sheet-team ${tm.alive ? "" : "out"}">
      <span class="dot" style="background:${o ? o.color : ""}"></span>
      <span class="team-name">${t}</span>
      <span class="team-prob">${tm.alive ? pct(tm.winProb) : "out"}</span></div>`;
  };

  $("#sheet-content").innerHTML = `
    <h2><span class="dot" style="background:${owner.color}"></span>${teamName}</h2>
    <p class="sub">${owner.name}'s team · ${team.alive ? "still in" : "eliminated"}</p>
    <div class="stat-grid">
      <div class="stat"><span class="sv">#${rank}</span><span class="sl">rank</span></div>
      <div class="stat"><span class="sv">${pct(combined)}</span><span class="sl">to win draw</span></div>
      <div class="stat"><span class="sv">${aliveTeams.length}/${owner.teams.length}</span><span class="sl">alive</span></div>
      <div class="stat"><span class="sv">${best ? abbr(best) : "–"}</span><span class="sl">best team</span></div>
    </div>
    <p class="sub">Deepest run: <strong>${deepestStageLabel(owner.id)}</strong></p>
    ${sparkline(owner.id, owner.color)}
    <div class="sheet-section">Still in (${aliveTeams.length})</div>
    ${aliveTeams.map(teamLine).join("") || `<div class="sheet-team out">none</div>`}
    ${outTeams.length ? `<div class="sheet-section">Knocked out (${outTeams.length})</div>` + outTeams.map(teamLine).join("") : ""}`;
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
$("#share-btn").addEventListener("click", shareView);
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
    renderLiveStrip();
    renderHighlights();
    markNextGame();
    if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
  } catch (e) { /* offline / transient — ignore */ }
}

// Poll faster while any game is around match time (result may land), slower when
// nothing's on.
function pollDelay() {
  const hot = STATE && ROUND_KEYS.some((k) =>
    (STATE.bracket[k] || []).some((m) => {
      if (!m.kickoff || m.winner != null) return false;
      const age = (Date.now() - Date.parse(m.kickoff)) / 60000;
      return age >= -15 && age <= 300;   // from just before KO to well after
    }));
  return hot ? 30000 : 90000;
}
(function scheduleRefresh() {
  setTimeout(async () => { await refreshData(); scheduleRefresh(); }, pollDelay());
})();

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
    renderLiveStrip();
    markNextGame();
    if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
  }
}, 60000);

// Live scores from the free feed: poll every ~25s while a game is on (fast,
// real-time), re-render in place when the score/minute changes.
let lastLiveSig = "";
let liveTimer = null;
function liveHot() {
  return STATE && ROUND_KEYS.some((k) => (STATE.bracket[k] || []).some((m) => {
    if (!m.kickoff || m.winner != null) return false;
    const age = (Date.now() - Date.parse(m.kickoff)) / 60000;
    return age >= -10 && age <= 200;
  }));
}
async function pollLiveScores() {
  clearTimeout(liveTimer);   // single chain even if called from multiple places
  const hot = liveHot();
  if (!document.hidden) {
    await fetchLiveScores();
    const sig = JSON.stringify(LIVE_SCORES);
    // Re-render on any change, and also each poll while a game is live so the
    // interpolated minute ticks forward between feed updates.
    const anyLive = STATE && ROUND_KEYS.some((k) => (STATE.bracket[k] || []).some(isLive));
    if ((sig !== lastLiveSig || anyLive) && STATE) {
      lastLiveSig = sig;
      const sl = $("#bracket").scrollLeft;
      renderTree();
      $("#bracket").scrollLeft = sl;
      renderLiveStrip();
      markNextGame();
      if (viewMode === "bracket") requestAnimationFrame(drawConnectors);
    }
  }
  liveTimer = setTimeout(pollLiveScores, hot ? 25000 : 120000);
}

// Auto-update the CODE too: if a newer version is deployed, reload to pick it
// up (URL keeps view/player/round). So the page never needs a manual refresh.
async function checkForUpdate() {
  try {
    const html = await (await fetch("index.html?t=" + Date.now(), { cache: "no-store" })).text();
    const m = html.match(/app\.js\?v=(\d+)/);
    if (m && parseInt(m[1], 10) > APP_VERSION) location.reload();
  } catch (e) { /* offline — ignore */ }
}
setInterval(checkForUpdate, 150000);   // every 2.5 min

// Returning to the tab: refresh data + feed + check for a new version so stale
// LIVE badges clear and new code lands promptly.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && STATE) { refreshData(); pollLiveScores(); checkForUpdate(); }
});

load()
  .then(() => { fetchLiveScores().then(() => { renderLiveStrip(); markNextGame(); }); pollLiveScores(); })
  .catch((err) => {
    document.getElementById("bracket").innerHTML =
      `<p style="color:#f66;padding:16px">Could not load data: ${err.message}</p>`;
  });
