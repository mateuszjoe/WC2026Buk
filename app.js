// =============================================================================
//  TYPER MŚ 2026 — aplikacja w czystym JavaScript (bez frameworków, bez build).
//  Dane wspólne trzymamy w Firebase (logowanie Google + baza Firestore).
//  Terminarz meczów i ustawienia punktacji są w plikach data/*.json w repo.
// =============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  collection,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const appRoot = document.getElementById("app");

// --- Jeśli ktoś jeszcze nie wkleił konfiguracji Firebase, pokaż instrukcję ----
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.includes("WKLEJ")) {
  appRoot.innerHTML = `
    <div class="setup-screen">
      <div class="setup-card">
        <div class="badge">Konfiguracja</div>
        <h1>Prawie gotowe 🎉</h1>
        <p>Aplikacja działa, ale brakuje połączenia z darmową bazą Firebase
        (logowanie + zapis typów). Otwórz plik <code>firebase-config.js</code>,
        wklej swoje dane z konsoli Firebase i odśwież stronę.</p>
        <p class="muted">Pełna instrukcja krok po kroku jest w pliku
        <code>README.md</code> oraz w komentarzach w <code>firebase-config.js</code>.</p>
      </div>
    </div>`;
  throw new Error("Brak konfiguracji Firebase — uzupełnij firebase-config.js");
}

// --- Inicjalizacja Firebase ---------------------------------------------------
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

// --- Stan aplikacji -----------------------------------------------------------
const state = {
  settings: null, // data/settings.json
  matches: [], // data/matches.json (posortowane wg daty)
  predictions: {}, // uid -> { name, email, matches:{matchId:{h,a}}, champion, updatedAt }
  admin: { results: {}, championTeamId: null }, // dokument admin/state
  user: null, // zalogowany użytkownik lub null
  view: "ranking", // aktywna zakładka
  myDraft: null, // lokalna kopia MOICH typów (edytowana w formularzu)
  myDraftSeededFor: null, // uid, dla którego zasialiśmy myDraft
  saveMsg: "" // komunikat o zapisie w widoku "Moje typy"
};

const VIEWS = [
  { id: "ranking", label: "Ranking" },
  { id: "matches", label: "Mecze" },
  { id: "mine", label: "Moje typy" },
  { id: "admin", label: "Panel admina", adminOnly: true }
];

// =============================================================================
//  PUNKTACJA  (przeniesiona 1:1 z oryginalnej wersji TypeScript)
// =============================================================================

function getOutcome(h, a) {
  if (typeof h !== "number" || typeof a !== "number" || !isFinite(h) || !isFinite(a)) {
    return null;
  }
  if (h > a) return "home";
  if (h < a) return "away";
  return "draw";
}

// pred = {h,a} | undefined ; result = {h,a} | undefined
function scoreMatch(pred, result, settings) {
  const empty = { points: 0, exact: false, correct: false };
  if (!pred || !result) return empty;

  const actual = getOutcome(result.h, result.a);
  const predicted = getOutcome(pred.h, pred.a);
  if (!actual || !predicted) return empty;

  if (pred.h === result.h && pred.a === result.a) {
    return { points: settings.points.exactScore, exact: true, correct: true };
  }
  const correct = predicted === actual;
  return { points: correct ? settings.points.correctResult : 0, exact: false, correct };
}

function scoreChampion(championPick, settings, championTeamId) {
  if (!championPick || !championTeamId) return 0;
  return championPick === championTeamId ? settings.points.tournamentWinner : 0;
}

// Zwycięzca turnieju: ręczne ustawienie admina ma pierwszeństwo, a jeśli go nie
// ma — bierzemy zwycięzcę meczu finałowego (jeśli już rozegrany).
function getChampionTeamId() {
  if (state.admin.championTeamId) return state.admin.championTeamId;
  const finalMatch = state.matches.find((m) => m.stage === "finał");
  if (!finalMatch) return null;
  const result = getResult(finalMatch);
  if (!result || result.h === result.a) return null;
  return result.h > result.a ? finalMatch.homeTeam.id : finalMatch.awayTeam.id;
}

function calculateLeaderboard() {
  const { settings, matches, predictions } = state;
  const championTeamId = getChampionTeamId();
  const rows = Object.entries(predictions).map(([uid, p]) => {
    let matchPoints = 0;
    let exactCount = 0;
    let correctCount = 0;

    for (const match of matches) {
      const pred = p.matches?.[match.id];
      const result = getResult(match);
      const s = scoreMatch(pred, result, settings);
      matchPoints += s.points;
      if (s.exact) exactCount += 1;
      if (s.correct) correctCount += 1;
    }

    const championPoints = scoreChampion(p.champion, settings, championTeamId);

    return {
      uid,
      name: p.name || "Gracz",
      total: matchPoints + championPoints,
      matchPoints,
      championPoints,
      exactCount,
      correctCount
    };
  });

  rows.sort((l, r) => {
    if (r.total !== l.total) return r.total - l.total;
    if (r.exactCount !== l.exactCount) return r.exactCount - l.exactCount;
    if (r.correctCount !== l.correctCount) return r.correctCount - l.correctCount;
    return l.name.localeCompare(r.name, "pl");
  });

  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

// =============================================================================
//  POMOCNICZE
// =============================================================================

function isAdmin() {
  return Boolean(
    state.user && state.settings && state.user.email === state.settings.adminEmail
  );
}

function matchLocked(match) {
  if (!state.settings?.lockPredictionsAtKickoff) return false;
  return Date.now() >= Date.parse(match.kickoffAt);
}

function championLocked() {
  if (!state.settings?.championLockAt) return false;
  return Date.now() >= Date.parse(state.settings.championLockAt);
}

// Wynik meczu: najpierw ręczna korekta admina (Firestore), a jeśli jej nie ma —
// wynik z pliku data/matches.json (uzupełniany automatycznie przez robota z API).
function getResult(match) {
  const override = state.admin.results?.[match.id];
  if (override && typeof override.h === "number" && typeof override.a === "number") {
    return override;
  }
  if (typeof match.homeScore === "number" && typeof match.awayScore === "number") {
    return { h: match.homeScore, a: match.awayScore };
  }
  return undefined;
}

function matchFinished(match) {
  return Boolean(getResult(match));
}

// Drużyny do wyboru "mistrza" — tylko realne reprezentacje. Pomijamy
// miejsca "TBD" z meczów pucharowych (jeszcze nieznane pary).
function isRealTeam(team) {
  return team && team.id && !String(team.id).startsWith("tbd-") && team.name !== "TBD";
}

function getTeams() {
  const map = new Map();
  for (const m of state.matches) {
    if (isRealTeam(m.homeTeam)) map.set(m.homeTeam.id, m.homeTeam);
    if (isRealTeam(m.awayTeam)) map.set(m.awayTeam.id, m.awayTeam);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

function teamName(id) {
  if (!id) return "—";
  for (const m of state.matches) {
    if (m.homeTeam.id === id) return m.homeTeam.name;
    if (m.awayTeam.id === id) return m.awayTeam.name;
  }
  return id;
}

function fmtDate(iso) {
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(iso));
}

function fmtStage(m) {
  return m.group ? `Grupa ${m.group}` : m.stage;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// =============================================================================
//  ZAPIS DO FIRESTORE (z opóźnieniem, żeby nie pisać na każde naciśnięcie klawisza)
// =============================================================================

let saveTimer = null;
function saveMyPredictionsDebounced() {
  if (!state.user) return;
  state.saveMsg = "Zapisywanie…";
  updateSaveIndicator();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await setDoc(
        doc(db, "predictions", state.user.uid),
        {
          name: (state.myDraft?.name || "").trim() || state.user.displayName || state.user.email,
          email: state.user.email,
          matches: state.myDraft.matches,
          champion: state.myDraft.champion || null,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
      state.saveMsg = "Zapisano ✓";
    } catch (e) {
      console.error(e);
      state.saveMsg = "Błąd zapisu — sprawdź reguły Firestore.";
    }
    updateSaveIndicator();
  }, 700);
}

let adminSaveTimer = null;
function saveAdminDebounced() {
  if (!isAdmin()) return;
  clearTimeout(adminSaveTimer);
  adminSaveTimer = setTimeout(async () => {
    try {
      await setDoc(
        doc(db, "admin", "state"),
        {
          results: state.admin.results,
          championTeamId: state.admin.championTeamId || null,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );
    } catch (e) {
      console.error(e);
      alert("Nie udało się zapisać. Czy na pewno jesteś adminem i reguły są wgrane?");
    }
  }, 500);
}

// =============================================================================
//  RENDEROWANIE
// =============================================================================

function render() {
  if (!state.settings) {
    appRoot.innerHTML = `<div class="boot">Wczytywanie danych…</div>`;
    return;
  }

  appRoot.innerHTML = `
    ${headerHtml()}
    <main class="container">
      ${viewHtml()}
    </main>
    <footer class="site-footer">
      Wóda! Szlugi! Grube baby!
    </footer>
  `;

  wireEvents();
}

// Lekkie odświeżenie podczas pisania w "Moich typach" — NIE przebudowujemy pól
// formularza (żeby nie tracić kursora), aktualizujemy tylko wskaźnik zapisu.
function maybeRender() {
  if (state.view === "mine") {
    updateSaveIndicator();
    return;
  }
  render();
}

function updateSaveIndicator() {
  const el = document.getElementById("save-indicator");
  if (el) el.textContent = state.saveMsg;
}

function headerHtml() {
  const tabs = VIEWS.filter((v) => !v.adminOnly || isAdmin())
    .map(
      (v) =>
        `<button class="tab ${state.view === v.id ? "active" : ""}" data-view="${v.id}">${v.label}</button>`
    )
    .join("");

  const account = state.user
    ? `<div class="account">
         <span class="who">${escapeHtml(state.user.displayName || state.user.email)}</span>
         <button class="btn ghost" id="logout">Wyloguj</button>
       </div>`
    : `<button class="btn primary" id="login">
         <span class="g-dot"></span> Zaloguj przez Google
       </button>`;

  return `
    <header class="site-header">
      <div class="container header-inner">
        <div class="brand">
          <div class="cup">🏆</div>
          <div>
            <div class="brand-title">${escapeHtml(state.settings.tournamentName)}</div>
            <div class="brand-sub">TYPER MORDORYJE</div>
          </div>
        </div>
        ${account}
      </div>
      <div class="container">
        <nav class="tabs">${tabs}</nav>
      </div>
    </header>`;
}

function viewHtml() {
  switch (state.view) {
    case "ranking":
      return rankingHtml();
    case "matches":
      return matchesHtml();
    case "mine":
      return mineHtml();
    case "admin":
      return isAdmin() ? adminHtml() : `<p class="muted">Brak dostępu.</p>`;
    default:
      return "";
  }
}

// --- Widok: Ranking -----------------------------------------------------------
function rankingHtml() {
  const board = calculateLeaderboard();
  const p = state.settings.points;

  const rows =
    board.length === 0
      ? `<tr><td colspan="7" class="muted center">Brak typów. Bądź pierwszy — zaloguj się i wpisz typy!</td></tr>`
      : board
          .map((r) => {
            const me = state.user && r.uid === state.user.uid;
            const medal = r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : r.rank;
            return `
            <tr class="${me ? "me" : ""}">
              <td class="rank">${medal}</td>
              <td class="name">${escapeHtml(r.name)}${me ? ' <span class="you">Ty</span>' : ""}</td>
              <td class="total"><strong>${r.total}</strong></td>
              <td>${r.matchPoints}</td>
              <td>${r.championPoints}</td>
              <td>${r.exactCount}</td>
              <td>${r.correctCount}</td>
            </tr>`;
          })
          .join("");

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Klasyfikacja</div>
          <h2>Ranking</h2>
        </div>
        <div class="points-legend">
          ${p.exactScore} pkt dokładny wynik · ${p.correctResult} pkt traf. rezultat · ${p.tournamentWinner} pkt mistrz
        </div>
      </div>
      <div class="card table-card">
        <table class="leaderboard">
          <thead>
            <tr>
              <th>#</th><th>Gracz</th><th>Suma</th><th>Mecze</th>
              <th>Mistrz</th><th>Dokł.</th><th>Rez.</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

// --- Widok: Mecze -------------------------------------------------------------
function matchesHtml() {
  const cards = state.matches
    .map((m) => {
      const result = getResult(m);
      const finished = Boolean(result);
      const score = finished ? `${result.h} : ${result.a}` : "–";
      const myPred = state.user ? state.predictions[state.user.uid]?.matches?.[m.id] : null;

      let myLine = "";
      if (myPred) {
        const s = scoreMatch(myPred, result, state.settings);
        const tag = finished
          ? `<span class="pts ${s.exact ? "exact" : s.correct ? "ok" : "miss"}">${s.points} pkt</span>`
          : `<span class="pts pending">czeka</span>`;
        myLine = `<div class="my-pred">Twój typ: <strong>${myPred.h} : ${myPred.a}</strong> ${tag}</div>`;
      }

      return `
        <article class="card match-card ${finished ? "done" : ""}">
          <div class="match-top">
            <span class="when">${fmtDate(m.kickoffAt)}</span>
            <span class="stage">${escapeHtml(fmtStage(m))}</span>
          </div>
          <div class="match-body">
            <span class="team home">${escapeHtml(m.homeTeam.name)}</span>
            <span class="score ${finished ? "final" : ""}">${score}</span>
            <span class="team away">${escapeHtml(m.awayTeam.name)}</span>
          </div>
          ${myLine}
        </article>`;
    })
    .join("");

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Terminarz i wyniki</div>
          <h2>Mecze</h2>
        </div>
      </div>
      <div class="match-grid">${cards}</div>
    </section>`;
}

// --- Widok: Moje typy ---------------------------------------------------------
function mineHtml() {
  if (!state.user) {
    return `
      <section class="stack">
        <div class="card login-card">
          <div class="cup big">🏆</div>
          <h2>Zaloguj się, żeby typować</h2>
          <p class="muted">Twoje typy zapiszą się automatycznie i będą liczone w rankingu.</p>
          <button class="btn primary" id="login-2"><span class="g-dot"></span> Zaloguj przez Google</button>
        </div>
      </section>`;
  }

  seedMyDraft();
  const champLocked = championLocked();

  const teamOptions = getTeams()
    .map(
      (t) =>
        `<option value="${t.id}" ${state.myDraft.champion === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`
    )
    .join("");

  const rows = state.matches
    .map((m) => {
      const locked = matchLocked(m);
      const pred = state.myDraft.matches[m.id] || {};
      const h = pred.h ?? "";
      const a = pred.a ?? "";
      return `
        <div class="pred-row ${locked ? "locked" : ""}">
          <div class="pred-info">
            <span class="row-date">${fmtDate(m.kickoffAt)} · ${escapeHtml(fmtStage(m))}</span>
            <span class="row-teams">${escapeHtml(m.homeTeam.name)} – ${escapeHtml(m.awayTeam.name)}</span>
          </div>
          <div class="pred-inputs">
            <input type="number" min="0" inputmode="numeric" class="score-in"
              data-match="${m.id}" data-side="h" value="${h}" ${locked ? "disabled" : ""}
              aria-label="Gospodarze ${escapeHtml(m.homeTeam.name)}" />
            <span class="colon">:</span>
            <input type="number" min="0" inputmode="numeric" class="score-in"
              data-match="${m.id}" data-side="a" value="${a}" ${locked ? "disabled" : ""}
              aria-label="Goście ${escapeHtml(m.awayTeam.name)}" />
            ${locked ? '<span class="lock-tag">🔒</span>' : ""}
          </div>
        </div>`;
    })
    .join("");

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Zapis dzieje się sam</div>
          <h2>Moje typy</h2>
        </div>
        <div id="save-indicator" class="save-indicator">${escapeHtml(state.saveMsg)}</div>
      </div>

      <div class="card profile-card">
        <div class="champion-left">
          <div class="champ-icon">🙋</div>
          <div>
            <div class="champ-title">Twój nick w typerze</div>
            <div class="muted small">Tak będziesz widoczny w rankingu (nie musi być nazwą z Google).</div>
          </div>
        </div>
        <input type="text" id="nick-input" maxlength="24" placeholder="np. Mati"
          value="${escapeHtml(state.myDraft.name || "")}" />
      </div>

      <div class="card champion-card">
        <div class="champion-left">
          <div class="champ-icon">👑</div>
          <div>
            <div class="champ-title">Mistrz turnieju</div>
            <div class="muted small">+${state.settings.points.tournamentWinner} pkt za trafienie</div>
          </div>
        </div>
        <select id="champion-select" ${champLocked ? "disabled" : ""}>
          <option value="">— wybierz —</option>
          ${teamOptions}
        </select>
        ${champLocked ? '<span class="lock-tag">🔒 zamknięte</span>' : ""}
      </div>

      <div class="card">
        <h3 class="card-title">Wyniki meczów</h3>
        <div class="pred-list">${rows}</div>
        <p class="muted small footnote">
          Mecze blokują się o godzinie rozpoczęcia. Blokada jest po stronie aplikacji
          (uczciwa zabawa), nie jest twardym zabezpieczeniem.
        </p>
      </div>
    </section>`;
}

// --- Widok: Panel admina ------------------------------------------------------
function adminHtml() {
  const champOptions = getTeams()
    .map(
      (t) =>
        `<option value="${t.id}" ${state.admin.championTeamId === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`
    )
    .join("");

  const rows = state.matches
    .map((m) => {
      const r = state.admin.results?.[m.id] || {};
      const h = typeof r.h === "number" ? r.h : "";
      const a = typeof r.a === "number" ? r.a : "";
      return `
        <div class="pred-row">
          <div class="pred-info">
            <span class="row-date">${fmtDate(m.kickoffAt)} · ${escapeHtml(fmtStage(m))}</span>
            <span class="row-teams">${escapeHtml(m.homeTeam.name)} – ${escapeHtml(m.awayTeam.name)}</span>
          </div>
          <div class="pred-inputs">
            <input type="number" min="0" inputmode="numeric" class="result-in"
              data-match="${m.id}" data-side="h" value="${h}" />
            <span class="colon">:</span>
            <input type="number" min="0" inputmode="numeric" class="result-in"
              data-match="${m.id}" data-side="a" value="${a}" />
            <button class="btn ghost tiny clear-result" data-match="${m.id}">wyczyść</button>
          </div>
        </div>`;
    })
    .join("");

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Tylko dla Ciebie</div>
          <h2>Panel admina</h2>
        </div>
      </div>

      <div class="card info-card">
        Wpisujesz tutaj prawdziwe wyniki meczów oraz mistrza turnieju. Zapisuje się
        automatycznie i od razu przelicza ranking u wszystkich. Żadnych commitów do GitHuba.
      </div>

      <div class="card champion-card">
        <div class="champion-left">
          <div class="champ-icon">👑</div>
          <div>
            <div class="champ-title">Mistrz turnieju (wynik końcowy)</div>
            <div class="muted small">Ustaw dopiero po finale — wtedy dolicza się ${state.settings.points.tournamentWinner} pkt.</div>
          </div>
        </div>
        <select id="admin-champion">
          <option value="">— nie rozstrzygnięto —</option>
          ${champOptions}
        </select>
      </div>

      <div class="card">
        <h3 class="card-title">Wyniki meczów</h3>
        <div class="pred-list">${rows}</div>
      </div>
    </section>`;
}

// =============================================================================
//  PODPINANIE ZDARZEŃ (po każdym render())
// =============================================================================

function wireEvents() {
  appRoot.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      state.saveMsg = "";
      render();
    })
  );

  const login = document.getElementById("login");
  const login2 = document.getElementById("login-2");
  if (login) login.addEventListener("click", doLogin);
  if (login2) login2.addEventListener("click", doLogin);

  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => signOut(auth));

  // Moje typy — nick
  const nickInput = document.getElementById("nick-input");
  if (nickInput)
    nickInput.addEventListener("input", () => {
      state.myDraft.name = nickInput.value;
      saveMyPredictionsDebounced();
    });

  // Moje typy — pola wyników
  appRoot.querySelectorAll(".score-in").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.match;
      const side = input.dataset.side;
      if (!state.myDraft.matches[id]) state.myDraft.matches[id] = {};
      const v = input.value === "" ? undefined : Math.max(0, Math.trunc(Number(input.value)));
      state.myDraft.matches[id][side] = v;
      // Usuń pusty typ (oba pola puste)
      const cur = state.myDraft.matches[id];
      if (cur.h === undefined && cur.a === undefined) delete state.myDraft.matches[id];
      saveMyPredictionsDebounced();
    });
  });

  const champSelect = document.getElementById("champion-select");
  if (champSelect)
    champSelect.addEventListener("change", () => {
      state.myDraft.champion = champSelect.value || null;
      saveMyPredictionsDebounced();
    });

  // Panel admina
  appRoot.querySelectorAll(".result-in").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.match;
      const side = input.dataset.side;
      if (!state.admin.results[id]) state.admin.results[id] = {};
      const v = input.value === "" ? undefined : Math.max(0, Math.trunc(Number(input.value)));
      state.admin.results[id][side] = v;
      const cur = state.admin.results[id];
      if (cur.h === undefined && cur.a === undefined) delete state.admin.results[id];
      saveAdminDebounced();
    });
  });

  appRoot.querySelectorAll(".clear-result").forEach((btn) => {
    btn.addEventListener("click", () => {
      delete state.admin.results[btn.dataset.match];
      saveAdminDebounced();
      render();
    });
  });

  const adminChamp = document.getElementById("admin-champion");
  if (adminChamp)
    adminChamp.addEventListener("change", () => {
      state.admin.championTeamId = adminChamp.value || null;
      saveAdminDebounced();
    });
}

async function doLogin() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error(e);
    if (e.code !== "auth/popup-closed-by-user") {
      alert("Nie udało się zalogować: " + (e.message || e.code));
    }
  }
}

// Zasiej lokalną kopię typów z tego, co jest w bazie dla zalogowanego gracza
function seedMyDraft() {
  if (!state.user) return;
  if (state.myDraftSeededFor === state.user.uid && state.myDraft) return;
  const mine = state.predictions[state.user.uid];
  state.myDraft = {
    name: mine?.name || state.user.displayName || state.user.email,
    matches: structuredClone(mine?.matches || {}),
    champion: mine?.champion || null
  };
  state.myDraftSeededFor = state.user.uid;
}

// =============================================================================
//  WCZYTYWANIE DANYCH + LISTENERY
// =============================================================================

async function loadStaticData() {
  const [settings, matches] = await Promise.all([
    fetch("./data/settings.json").then((r) => r.json()),
    fetch("./data/matches.json").then((r) => r.json())
  ]);
  state.settings = settings;
  state.matches = [...matches].sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
}

// Reguły Firestore pozwalają czytać tylko zalogowanym, więc listenery startują
// dopiero po zalogowaniu i są odpinane po wylogowaniu.
let unsubscribers = [];

function listenToFirestore() {
  if (unsubscribers.length) return; // już podpięte

  // Wszystkie typy graczy (do rankingu)
  unsubscribers.push(
    onSnapshot(
      collection(db, "predictions"),
      (snap) => {
        const next = {};
        snap.forEach((d) => (next[d.id] = d.data()));
        state.predictions = next;
        maybeRender();
      },
      (err) => console.error("predictions:", err.message)
    )
  );

  // Wyniki meczów + mistrz (ustawiane przez admina)
  unsubscribers.push(
    onSnapshot(
      doc(db, "admin", "state"),
      (d) => {
        const data = d.data() || {};
        state.admin = {
          results: data.results || {},
          championTeamId: data.championTeamId || null
        };
        maybeRender();
      },
      (err) => console.error("admin/state:", err.message)
    )
  );
}

function stopListening() {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.myDraft = null;
  state.myDraftSeededFor = null;

  if (user) {
    listenToFirestore();
  } else {
    stopListening();
    state.predictions = {};
    state.admin = { results: {}, championTeamId: null };
  }

  // Jeśli admin się wylogował z widoku admina — wróć do rankingu
  if (state.view === "admin" && !isAdmin()) state.view = "ranking";
  render();
});

// --- Start --------------------------------------------------------------------
(async function start() {
  try {
    await loadStaticData();
    render();
  } catch (e) {
    console.error(e);
    appRoot.innerHTML = `<div class="boot error">Nie udało się wczytać danych (data/*.json).<br>${escapeHtml(
      e.message || ""
    )}</div>`;
  }
})();
