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

const pct = (p) => (p == null ? "" : Math.round(p * 100) + "%");
const $ = (sel) => document.querySelector(sel);

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
  scrollToCurrentRound();
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
    return `<div class="team-row"><span class="team-name tbd-name">TBD</span></div>`;
  }
  const team = STATE.teams[teamName];
  const decided = match.winner != null;
  const isWinner = match.winner === side;
  const owner = team?.owner;
  const sel = selectedPlayer && owner === selectedPlayer ? " match-team-selected" : "";
  const cls = decided ? (isWinner ? " winner" : " loser") : "";
  // Show % only when BOTH teams known (head-to-head set) and not yet decided.
  const showProb = match.teamA && match.teamB && !decided;
  return `
    <div class="team-row${cls}${sel}" data-owner="${owner || ""}" data-team="${teamName}">
      <span class="dot" style="background:${ownerColor(teamName)}"></span>
      <span>
        <span class="team-name">${teamName}</span>
        <span class="team-owner"> · ${ownerTag(teamName)}</span>
      </span>
      ${showProb ? `<span class="team-prob">${pct(prob)}</span>` : ""}
    </div>`;
}

function renderBracket() {
  const wrap = $("#bracket");
  wrap.innerHTML = "";
  const nav = $("#round-nav");
  nav.innerHTML = "";

  ROUNDS.forEach(([key, label]) => {
    const matches = STATE.bracket[key] || [];
    const col = document.createElement("section");
    col.className = "round";
    col.id = "round-" + key;
    col.innerHTML = `<div class="round-label">${label}</div>`;
    matches.forEach((m) => {
      const known = m.teamA && m.teamB;
      const div = document.createElement("div");
      div.className = "match" + (known ? "" : " tbd");
      div.innerHTML =
        teamRow(m.teamA, m.probA, m, "A") +
        teamRow(m.teamB, m.probB, m, "B");
      col.appendChild(div);
    });
    wrap.appendChild(col);

    const btn = document.createElement("button");
    btn.textContent = label.replace("Round of ", "R");
    btn.dataset.round = key;
    if (key === STATE.currentRound) btn.classList.add("active");
    btn.addEventListener("click", () =>
      $("#round-" + key).scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" }));
    nav.appendChild(btn);
  });

  wrap.querySelectorAll(".team-row[data-team]").forEach((row) => {
    row.addEventListener("click", () => openTeamSheet(row.dataset.team));
  });
}

function togglePlayer(id) {
  selectedPlayer = selectedPlayer === id ? null : id;
  document.body.classList.toggle("has-selection", !!selectedPlayer);
  renderStandings();
  renderBracket();
}

function scrollToCurrentRound() {
  // Instant (not smooth): smooth + CSS scroll-snap can fight in a loop on some
  // engines. Scroll the bracket container horizontally to the current round.
  const el = document.getElementById("round-" + STATE.currentRound);
  const wrap = $("#bracket");
  if (el && wrap) wrap.scrollLeft = el.offsetLeft - wrap.offsetLeft;
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

load().catch((err) => {
  document.getElementById("bracket").innerHTML =
    `<p style="color:#f66;padding:16px">Could not load data: ${err.message}</p>`;
});
