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
  signInWithRedirect,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  limit,
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

// Klucz publiczny VAPID do prawdziwego push (wysyłką zajmuje się robot na GitHubie).
const VAPID_PUBLIC =
  "BAQl5Gb6pj34iL4XK6NAtjsmNDhYJB7gkOLB5KFE93taOpMLVtFMlhShRBqQjjNekXn5eRC3TT9ysggxZyVXgJM";

// --- Stan aplikacji -----------------------------------------------------------
const state = {
  settings: null, // data/settings.json
  matches: [], // data/matches.json (posortowane wg daty)
  predictions: {}, // uid -> { name, email, matches:{matchId:{h,a}}, champion, updatedAt }
  admin: { results: {}, championTeamId: null }, // dokument admin/state
  user: null, // zalogowany użytkownik lub null
  view: "ranking", // aktywna zakładka
  matchView: "groups", // układ meczów: "groups" (wg grup) | "dates" (wg dat)
  chat: [], // wiadomości czatu (najnowsze na dole)
  chatDraft: "", // treść wpisywanej wiadomości
  chatImage: null, // załączone zdjęcie (data URL) do wysłania
  chatOpen: false, // czy dymek czatu jest rozwinięty (panel nad aplikacją)
  chatLastRead: 0, // ms ostatnio odczytanej wiadomości (licznik nieprzeczytanych)
  myDraft: null, // lokalna kopia MOICH typów (edytowana w formularzu)
  myDraftSeededFor: null, // uid, dla którego zasialiśmy myDraft
  saveMsg: "", // komunikat o zapisie w widoku "Moje typy"
  avatarSeed: 0, // ziarno dla losowania avatarów
  // Powiadomienia (in-app, gdy aplikacja jest otwarta):
  notifyInit: false, // czy ustalono punkt odniesienia
  notifyPromptDone: false, // czy jednorazowy popup o powiadomieniach już zamknięty
  lastLeaderUid: null, // ostatni lider rankingu
  notifiedFinished: new Set() // mecze, o których już powiadomiono
};

const VIEWS = [
  { id: "ranking", label: "Ranking" },
  { id: "matches", label: "Mecze" },
  { id: "mine", label: "Moje typy" },
  { id: "profile", label: "Profil", authOnly: true },
  { id: "rules", label: "Regulamin" },
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

// Mecz pucharowy (poza fazą grupową).
function isKnockout(m) {
  return Boolean(m && m.stage && m.stage !== "group");
}

// Która strona faktycznie awansowała (też po dogrywce/karnych) — z pola winner.
function advancingSide(m) {
  if (m.winner === "HOME_TEAM") return "h";
  if (m.winner === "AWAY_TEAM") return "a";
  return null;
}

// Bonus za wskazanie drużyny awansującej. Liczy się TYLKO, gdy:
//  - to mecz pucharowy,
//  - w regulaminowym czasie (90') był REMIS,
//  - gracz typował remis (czyli trafił rezultat),
//  - i wskazał właściwą drużynę awansującą (po dogrywce/karnych).
// Jeśli gracz typował remis, a drużyna awansowała wygraną w 90' — 0 pkt (rezultat nietrafiony).
function advanceBonus(pred, result, m, settings) {
  if (!isKnockout(m) || !pred || !result) return 0;
  if (getOutcome(result.h, result.a) !== "draw") return 0; // 90' nie był remisem
  if (getOutcome(pred.h, pred.a) !== "draw") return 0; // gracz nie typował remisu
  const actual = advancingSide(m);
  if (!actual || !pred.adv) return 0;
  return pred.adv === actual ? settings.points.advanceBonus ?? 1 : 0;
}

// Zwycięzca turnieju: ręczne ustawienie admina ma pierwszeństwo, a jeśli go nie
// ma — bierzemy zwycięzcę meczu finałowego (jeśli już rozegrany).
function getChampionTeamId() {
  if (state.admin.championTeamId) return state.admin.championTeamId;
  const finalMatch = state.matches.find((m) => m.stage === "finał");
  if (!finalMatch) return null;
  // Mistrz = faktyczny zdobywca pucharu (liczy się też dogrywka/karne).
  if (finalMatch.winner === "HOME_TEAM") return finalMatch.homeTeam.id;
  if (finalMatch.winner === "AWAY_TEAM") return finalMatch.awayTeam.id;
  // Fallback (np. stare dane bez pola winner): zwycięzca z wyniku 90'.
  const result = getResult(finalMatch);
  if (!result || result.h === result.a) return null;
  return result.h > result.a ? finalMatch.homeTeam.id : finalMatch.awayTeam.id;
}

// Jak daleko zaszła dana drużyna (do dogrywki remisów na "typ na mistrza").
const STAGE_RANK = {
  group: 0,
  "1/16 finału": 1,
  "1/8 finału": 2,
  ćwierćfinał: 3,
  półfinał: 4,
  "mecz o 3. miejsce": 5,
  finał: 6
};
function championProgress(teamId) {
  if (!teamId) return -1;
  let best = -1;
  for (const m of state.matches) {
    if (m.homeTeam.id === teamId || m.awayTeam.id === teamId) {
      best = Math.max(best, STAGE_RANK[m.stage] ?? 0);
    }
  }
  if (teamId === getChampionTeamId()) best = 100; // został mistrzem
  return best;
}

function calculateLeaderboard() {
  const { settings, matches, predictions } = state;
  const championTeamId = getChampionTeamId();
  const rows = Object.entries(predictions).map(([uid, p]) => {
    let exactCount = 0;
    let outcomeOnlyCount = 0; // trafiony rezultat, ale nie dokładny wynik
    let advanceCount = 0; // trafione wskazania drużyny awansującej (po remisie w 90')

    for (const match of matches) {
      const pred = p.matches?.[match.id];
      const result = getResult(match);
      const s = scoreMatch(pred, result, settings);
      if (s.exact) exactCount += 1;
      else if (s.correct) outcomeOnlyCount += 1;
      if (advanceBonus(pred, result, match, settings) > 0) advanceCount += 1;
    }

    const exactPoints = exactCount * settings.points.exactScore;
    const outcomePoints = outcomeOnlyCount * settings.points.correctResult;
    const advancePoints = advanceCount * (settings.points.advanceBonus ?? 1);
    const championPoints = scoreChampion(p.champion, settings, championTeamId);

    return {
      uid,
      name: p.name || "Gracz",
      total: exactPoints + outcomePoints + advancePoints + championPoints,
      exactPoints,
      outcomePoints,
      advancePoints,
      championPoints,
      exactCount,
      outcomeOnlyCount,
      advanceCount,
      championProgress: championPoints > 0 ? 1000 : championProgress(p.champion)
    };
  });

  // Remis rozstrzyga kolejno: dokładne wyniki → trafiony mistrz →
  // rezultaty → bonusy za awans → jak wysoko zaszedł typ na mistrza → nazwa.
  rows.sort((l, r) => {
    if (r.total !== l.total) return r.total - l.total;
    if (r.exactCount !== l.exactCount) return r.exactCount - l.exactCount;
    if (r.championPoints !== l.championPoints) return r.championPoints - l.championPoints;
    if (r.outcomeOnlyCount !== l.outcomeOnlyCount) return r.outcomeOnlyCount - l.outcomeOnlyCount;
    if (r.advanceCount !== l.advanceCount) return r.advanceCount - l.advanceCount;
    if (r.championProgress !== l.championProgress) return r.championProgress - l.championProgress;
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

// Mecz zamyka się 5 minut PRZED rozpoczęciem.
const LOCK_BEFORE_MS = 5 * 60 * 1000;
// Koniec meczu po starcie: 90 min gry + 15 min przerwy = 105 min.
const MATCH_DURATION_MS = (90 + 15) * 60 * 1000;
function matchLocked(match) {
  if (!state.settings?.lockPredictionsAtKickoff) return false;
  return Date.now() >= Date.parse(match.kickoffAt) - LOCK_BEFORE_MS;
}

// Ostatni mecz 1. kolejki fazy grupowej (wg czasu rozpoczęcia).
// 1. kolejka = po 2 mecze w każdej grupie. Jeśli dane mają numer kolejki
// (matchday), używamy go; w innym razie bierzemy liczba_grup * 2 najwcześniejszych.
function lastRoundOneMatch() {
  const groupMatches = state.matches
    .filter((m) => m.stage === "group" && m.group)
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
  if (!groupMatches.length) return null;
  let roundOne;
  if (groupMatches.some((m) => typeof m.matchday === "number")) {
    roundOne = groupMatches.filter((m) => m.matchday === 1);
  } else {
    const groupCount = new Set(groupMatches.map((m) => m.group)).size;
    roundOne = groupMatches.slice(0, groupCount * 2);
  }
  if (!roundOne.length) return null;
  return roundOne.reduce((a, b) => (a.kickoffAt >= b.kickoffAt ? a : b));
}

// Koniec 1. kolejki = rozpoczęcie ostatniego meczu 1. kolejki + 90 min + 15 min
// przerwy (timestamp w ms). Date sam ogarnia przejście przez północ na kolejny dzień.
function roundOneEndMs() {
  const last = lastRoundOneMatch();
  if (last) return Date.parse(last.kickoffAt) + MATCH_DURATION_MS;
  if (state.settings?.championLockAt) return Date.parse(state.settings.championLockAt);
  return null;
}

// Typ mistrza można zmieniać tylko DO KOŃCA 1. kolejki (patrz wyżej).
function championLocked() {
  const end = roundOneEndMs();
  return end != null && Date.now() >= end;
}

// Czytelny termin blokady mistrza (w strefie czasowej gracza).
function champDeadlineText() {
  const end = roundOneEndMs();
  if (end == null) return "";
  return (
    " — do " +
    new Intl.DateTimeFormat("pl-PL", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(end))
  );
}

// Wynik meczu: najpierw ręczna korekta admina (Firestore), a jeśli jej nie ma —
// wynik z pliku data/matches.json (uzupełniany automatycznie przez robota z API).
function getResult(match) {
  const override = state.admin.results?.[match.id];
  if (override && typeof override.h === "number" && typeof override.a === "number") {
    return override;
  }
  // Faza pucharowa: do typów liczy się TYLKO czas regulaminowy (90'). Jeśli mecz
  // rozstrzygnięto w dogrywce/karnych (duration != REGULAR), auto-wynik z API
  // zawiera dogrywkę — nie używamy go; wynik z 90' wpisuje admin w panelu.
  if (match.duration && match.duration !== "REGULAR") return undefined;
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

function teamById(id) {
  if (!id) return null;
  for (const m of state.matches) {
    if (m.homeTeam.id === id) return m.homeTeam;
    if (m.awayTeam.id === id) return m.awayTeam;
  }
  return null;
}

function teamName(id) {
  return teamById(id)?.name || "—";
}

// Kody ISO krajów — żeby wszystkie flagi pochodziły z JEDNEGO źródła (flagcdn.com)
// i były jednolite stylistycznie. Dane (data/matches.json) mają mieszankę
// płaskich flag i herbów federacji, więc tutaj nadpisujemy je spójną flagą.
const TEAM_ISO = {
  Algieria: "dz", Anglia: "gb-eng", "Arabia Saudyjska": "sa", Argentyna: "ar",
  Australia: "au", Austria: "at", Belgia: "be", "Bośnia i Hercegowina": "ba",
  Brazylia: "br", Chorwacja: "hr", "Curaçao": "cw", Czechy: "cz",
  "DR Konga": "cd", Egipt: "eg", Ekwador: "ec", Francja: "fr",
  Ghana: "gh", Haiti: "ht", Hiszpania: "es", Holandia: "nl",
  Irak: "iq", Iran: "ir", Japonia: "jp", Jordania: "jo",
  Kanada: "ca", Katar: "qa", Kolumbia: "co", "Korea Płd.": "kr",
  Maroko: "ma", Meksyk: "mx", Niemcy: "de", Norwegia: "no",
  "Nowa Zelandia": "nz", Panama: "pa", Paragwaj: "py", Portugalia: "pt",
  RPA: "za", "Republika Zielonego Przylądka": "cv", Senegal: "sn",
  Szkocja: "gb-sct", Szwajcaria: "ch", Szwecja: "se", Tunezja: "tn",
  Turcja: "tr", USA: "us", Urugwaj: "uy", Uzbekistan: "uz",
  "Wybrzeże Kości Słoniowej": "ci"
};

// Jednolity URL flagi: kod ISO → flagcdn.com; fallback na crest z danych.
function flagUrl(team) {
  if (!team) return "";
  const iso = TEAM_ISO[team.name];
  if (iso) return `https://flagcdn.com/${iso}.svg`;
  return team.crest || "";
}

// Mała flaga drużyny obok nazwy (jednolite źródło).
function flagImg(team, cls = "flag") {
  const url = flagUrl(team);
  if (!url) return "";
  return `<img class="${cls}" src="${url}" alt="" loading="lazy" />`;
}

// Mocne emoji do wyboru (szybki, wyrazisty avatar na gradiencie — np. czaszka).
const AVATAR_EMOJIS = [
  "💀", "☠️", "🔥", "😈", "👹", "👺", "👽", "🤖", "🥷", "🤡",
  "👑", "🏆", "🐐", "🦁", "🐉", "🦅", "🐺", "🦈", "🦍", "🐍",
  "⚽", "🍺", "🍷", "🚬", "💩", "🤙", "🤑", "🥶", "😎", "🤠"
];

// Style generowanych grafik (DiceBear — darmowe, bez klucza, zwraca SVG).
// Tylko wyraziste, "charakterne" — bez nudnych abstraktów (rings/identicon/shapes/glass).
const AVATAR_STYLES = [
  "bottts", "fun-emoji", "avataaars", "big-smile", "adventurer",
  "adventurer-neutral", "micah", "lorelei", "notionists", "thumbs",
  "pixel-art", "croodles", "open-peeps", "personas", "miniavs", "dylan"
];

// Wyraziste, "boiskowe" tła avatarów.
const AVATAR_BG = [
  "1abc9c", "2ecc71", "3498db", "9b59b6", "e67e22",
  "e74c3c", "f1c40f", "16a085", "2980b9", "d35400"
];

// Generuje zestaw propozycji avatarów (URL-e), zależny od "ziarna" (reroll).
function avatarOptions() {
  const base = encodeURIComponent(state.myDraft?.name || state.user?.uid || "gracz");
  const salt = state.avatarSeed || 0;
  return AVATAR_STYLES.map((style, i) => {
    const bg = AVATAR_BG[(salt + i) % AVATAR_BG.length];
    return (
      `https://api.dicebear.com/9.x/${style}/svg?seed=${base}-${salt}-${i}` +
      `&radius=50&backgroundColor=${bg}&backgroundType=gradientLinear`
    );
  });
}

// Inicjały z nazwy (gdy brak avatara i zdjęcia z Google).
function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "?";
}

// HTML avatara gracza + mini-flaga jego typowanego mistrza (jeśli wybrał).
function avatarHtml(p, cls = "") {
  const av = p.avatar;
  let inner;
  if (av && av !== "none" && /^(https?:\/\/|data:image\/)/.test(av)) {
    inner = `<img src="${escapeHtml(av)}" alt="" />`;
  } else if (av && av !== "none" && !/^(https?:|data:)/.test(av)) {
    inner = `<span class="ava-emoji">${escapeHtml(av)}</span>`;
  } else if (av !== "none" && p.photo) {
    inner = `<img src="${escapeHtml(p.photo)}" alt="" />`;
  } else {
    inner = `<span class="ava-initials">${escapeHtml(initials(p.name))}</span>`;
  }
  const champ = teamById(p.champion);
  const champFlag = flagUrl(champ);
  const flag = champFlag
    ? `<img class="ava-flag" src="${champFlag}" alt="" title="Typ na mistrza: ${escapeHtml(champ.name)}" />`
    : "";
  return `<span class="avatar ${cls}">${inner}${flag}</span>`;
}

// --- Kadrowanie własnego zdjęcia w kółku -------------------------------------
// Samodzielny modal (poza render(), doczepiony do <body>), żeby przebudowa DOM
// nie zniszczyła go w trakcie kadrowania. Zapis: małe JPEG (256px) jako data URL.
function openAvatarCropper(file) {
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => buildCropper(img, objectUrl);
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    alert("Nie udało się wczytać tego pliku jako obrazka.");
  };
  img.src = objectUrl;
}

function buildCropper(img, objectUrl) {
  const STAGE = 280; // rozmiar kwadratowej sceny (px)
  const OUT = 256; // rozmiar zapisywanego avatara (px)
  // obraz "cover" sceny przy zoom=1
  const baseScale = STAGE / Math.min(img.naturalWidth, img.naturalHeight);
  let zoom = 1;
  const dispW = () => img.naturalWidth * baseScale * zoom;
  const dispH = () => img.naturalHeight * baseScale * zoom;
  let ox = (STAGE - dispW()) / 2; // offset lewego-górnego rogu obrazu (px, <=0)
  let oy = (STAGE - dispH()) / 2;

  const clamp = () => {
    ox = Math.min(0, Math.max(STAGE - dispW(), ox));
    oy = Math.min(0, Math.max(STAGE - dispH(), oy));
  };
  clamp();

  const overlay = document.createElement("div");
  overlay.className = "cropper-overlay";
  overlay.innerHTML = `
    <div class="cropper-box">
      <h3>Wykadruj zdjęcie</h3>
      <p class="muted small">Przesuń palcem/myszką, suwakiem przybliż. Wycinek w kółku to Twój avatar.</p>
      <div class="cropper-stage" style="width:${STAGE}px;height:${STAGE}px">
        <img class="cropper-img" alt="" draggable="false" />
        <div class="cropper-ring"></div>
      </div>
      <input type="range" class="cropper-zoom" min="1" max="4" step="0.01" value="1" />
      <div class="cropper-actions">
        <button class="btn ghost" data-crop="cancel">Anuluj</button>
        <button class="btn primary" data-crop="save">Zapisz avatar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const elImg = overlay.querySelector(".cropper-img");
  const elZoom = overlay.querySelector(".cropper-zoom");
  const stage = overlay.querySelector(".cropper-stage");
  elImg.src = img.src;

  const apply = () => {
    elImg.style.width = dispW() + "px";
    elImg.style.height = dispH() + "px";
    elImg.style.left = ox + "px";
    elImg.style.top = oy + "px";
  };
  apply();

  const pt = (e) =>
    e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
  let dragging = false,
    lastX = 0,
    lastY = 0;
  const onDown = (e) => {
    dragging = true;
    const p = pt(e);
    lastX = p.x;
    lastY = p.y;
  };
  const onMove = (e) => {
    if (!dragging) return;
    const p = pt(e);
    ox += p.x - lastX;
    oy += p.y - lastY;
    lastX = p.x;
    lastY = p.y;
    clamp();
    apply();
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => {
    dragging = false;
  };
  stage.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  stage.addEventListener("touchstart", onDown, { passive: false });
  stage.addEventListener("touchmove", onMove, { passive: false });
  stage.addEventListener("touchend", onUp);

  elZoom.addEventListener("input", () => {
    const cx = STAGE / 2,
      cy = STAGE / 2;
    const relX = (cx - ox) / dispW();
    const relY = (cy - oy) / dispH();
    zoom = parseFloat(elZoom.value);
    ox = cx - relX * dispW();
    oy = cy - relY * dispH();
    clamp();
    apply();
  });

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    URL.revokeObjectURL(objectUrl);
    overlay.remove();
  };

  overlay.querySelector('[data-crop="cancel"]').addEventListener("click", cleanup);
  overlay.querySelector('[data-crop="save"]').addEventListener("click", async () => {
    const scale = baseScale * zoom;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, -ox / scale, -oy / scale, STAGE / scale, STAGE / scale, 0, 0, OUT, OUT);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    cleanup();
    state.myDraft.avatar = dataUrl;
    await saveProfile();
    render();
  });
  // klik w ciemne tło = anuluj (mousedown, by nie kolidowało z przeciąganiem)
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cleanup();
  });
}

// Profil zalogowanego gracza (z bazy lub domyślny z konta Google).
function myProfile() {
  if (!state.user) return { name: "", avatar: null, photo: null, champion: null };
  const mine = state.predictions[state.user.uid] || {};
  return {
    name: mine.name || state.user.displayName || state.user.email,
    avatar: mine.avatar || null,
    photo: mine.photo || state.user.photoURL || null,
    champion: mine.champion || null
  };
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

// Krótka data: "11.06, 21:00"
function fmtShort(iso) {
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(iso));
}

// Mecze pogrupowane: { A:[...], B:[...] } (tylko faza grupowa, posortowane wg daty)
function matchesByGroup() {
  const groups = {};
  for (const m of state.matches) {
    if (m.stage === "group" && m.group) (groups[m.group] ||= []).push(m);
  }
  for (const g of Object.values(groups)) {
    g.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
  }
  return groups;
}

// Mecze pucharowe pogrupowane wg etapu, w kolejności turniejowej.
const STAGE_ORDER = ["1/16 finału", "1/8 finału", "ćwierćfinał", "półfinał", "mecz o 3. miejsce", "finał"];
function knockoutByStage() {
  const byStage = {};
  for (const m of state.matches) {
    if (m.stage !== "group") (byStage[m.stage] ||= []).push(m);
  }
  for (const s of Object.values(byStage)) {
    s.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
  }
  return STAGE_ORDER.filter((s) => byStage[s]).map((s) => [s, byStage[s]]);
}

// Klucz dnia w LOKALNEJ strefie (żeby mecze nocne nie wpadały do złego dnia).
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// Etykieta dnia: "środa, 11 czerwca".
function fmtDay(iso) {
  return new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).format(new Date(iso));
}

// Wszystkie mecze z ustalonymi drużynami, posortowane chronologicznie.
function allKnownMatchesSorted() {
  return state.matches
    .filter((m) => isRealTeam(m.homeTeam) && isRealTeam(m.awayTeam))
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
}

// Mecze pogrupowane wg dnia kalendarzowego: [ [klucz, etykieta, mecze[]], ... ].
function matchesByDate(list) {
  const byDay = new Map();
  for (const m of list) {
    const key = dayKey(m.kickoffAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(m);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ms]) => [key, fmtDay(ms[0].kickoffAt), ms]);
}

// Tabela grupy policzona z rozegranych meczów (wszystkie 4 drużyny, też z 0 pkt).
function groupTable(matches) {
  const stats = new Map();
  const ensure = (t) => {
    if (!stats.has(t.id))
      stats.set(t.id, { team: t, pl: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
    return stats.get(t.id);
  };
  for (const m of matches) {
    if (!isRealTeam(m.homeTeam) || !isRealTeam(m.awayTeam)) continue;
    const home = ensure(m.homeTeam);
    const away = ensure(m.awayTeam);
    const r = getResult(m);
    if (!r) continue;
    home.pl++; away.pl++;
    home.gf += r.h; home.ga += r.a;
    away.gf += r.a; away.ga += r.h;
    if (r.h > r.a) { home.w++; home.pts += 3; away.l++; }
    else if (r.h < r.a) { away.w++; away.pts += 3; home.l++; }
    else { home.d++; away.d++; home.pts++; away.pts++; }
  }
  return [...stats.values()].sort(
    (a, b) =>
      b.pts - a.pts ||
      b.gf - b.ga - (a.gf - a.ga) ||
      b.gf - a.gf ||
      a.team.name.localeCompare(b.team.name, "pl")
  );
}

// HTML tabeli grupy (kompaktowa, w stylu turniejowym).
function standingsTableHtml(matches) {
  const table = groupTable(matches);
  if (!table.length) return "";
  const rows = table
    .map((s, i) => {
      const qual = i < 2 ? "qual" : "";
      return `<tr class="${qual}">
        <td class="pos">${i + 1}</td>
        <td class="t">${flagImg(s.team)} ${escapeHtml(s.team.name)}</td>
        <td>${s.pl}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td>
        <td class="gd">${s.gf}:${s.ga}</td>
        <td class="pts">${s.pts}</td>
      </tr>`;
    })
    .join("");
  return `
    <table class="standings">
      <thead><tr>
        <th></th><th class="t">Drużyna</th><th>M</th><th>Z</th><th>R</th><th>P</th><th>Bramki</th><th>Pkt</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Etykieta punktów dla mojego typu na dany mecz.
function myPredTag(myPred, result, m) {
  if (!myPred) return "";
  const s = scoreMatch(myPred, result, state.settings);
  const bonus = m ? advanceBonus(myPred, result, m, state.settings) : 0;
  const cls = result ? (bonus > 0 || s.exact ? "exact" : s.correct ? "ok" : "miss") : "pending";
  const advTxt =
    m && isKnockout(m) && myPred.adv
      ? ` · awans: ${escapeHtml(myPred.adv === "h" ? m.homeTeam.name : m.awayTeam.name)}`
      : "";
  const label = result ? `${s.points + bonus} pkt${bonus ? ` (+${bonus} awans 🎯)` : ""}` : "czeka";
  return `<span class="pts ${cls}">Typ ${myPred.h}:${myPred.a}${advTxt} · ${label}</span>`;
}

// Status meczu po polsku (na podstawie pola status z API).
function liveTag(m) {
  if (m.status === "IN_PLAY" || m.status === "PAUSED") return '<span class="live">● LIVE</span>';
  if (matchFinished(m)) return '<span class="ft">KONIEC</span>';
  return "";
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
          photo: state.user.photoURL || null,
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

// Zapis danych profilu (nick / avatar) — natychmiast, bez opóźnienia.
async function saveProfile() {
  if (!state.user) return;
  try {
    await setDoc(
      doc(db, "predictions", state.user.uid),
      {
        name: (state.myDraft.name || "").trim() || state.user.displayName || state.user.email,
        nameSet: !!state.myDraft.nameSet,
        avatar: state.myDraft.avatar || null,
        photo: state.user.photoURL || null,
        email: state.user.email,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );
    state.saveMsg = "Zapisano ✓";
  } catch (e) {
    console.error(e);
    state.saveMsg = "Błąd zapisu — sprawdź reguły Firestore.";
  }
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
    ${inAppWarningHtml()}
    ${heroBannerHtml()}
    ${headerHtml()}
    <main class="container">
      ${viewHtml()}
    </main>
    <footer class="site-footer">
      Wóda! Szlugi! Grube baby!
    </footer>
    ${notifyPromptHtml()}
  `;

  wireEvents();

  // Pływający dymek czatu — żyje poza #app (na <body>), więc otwieranie/zamykanie
  // nie rusza strony pod spodem. Montujemy raz, potem tylko odświeżamy.
  mountChatWidget();
  updateChatWidget();
}

// Lekkie odświeżenie podczas pisania w "Moich typach" — NIE przebudowujemy pól
// formularza (żeby nie tracić kursora), aktualizujemy tylko wskaźnik zapisu.
function maybeRender() {
  // Na widokach z polami tekstowymi nie przebudowujemy DOM (żeby nie tracić
  // kursora podczas pisania) — odświeżamy tylko wskaźnik zapisu.
  if (state.view === "mine" || state.view === "profile") {
    updateSaveIndicator();
    return;
  }
  render();
}

function updateSaveIndicator() {
  const el = document.getElementById("save-indicator");
  if (el) el.textContent = state.saveMsg;
}

// Baner widoczny tylko w przeglądarce wbudowanej (Messenger/FB/IG), gdzie
// logowanie Google nie działa. Znika po zalogowaniu (gdyby ktoś jednak wszedł).
function inAppWarningHtml() {
  if (!isInAppBrowser() || state.user) return "";
  return `
    <div class="inapp-warn">
      <div class="container inapp-warn-inner">
        <span class="inapp-warn-text">
          ⚠️ Otwórz w <strong>Chrome / Safari</strong> — logowanie przez Google nie działa
          w przeglądarce Messengera/Facebooka (dlatego biały ekran).
          Kliknij <strong>⋮</strong> w rogu → „Otwórz w przeglądarce".
        </span>
        <button class="btn primary tiny" id="open-external">Otwórz w przeglądarce</button>
      </div>
    </div>`;
}

// Hero-baner: CAŁA grafika "Wóda! Szlugi! Grube baby!" widoczna na górze,
// nad sticky-nawigacją. Przewija się z treścią; nawigacja zostaje pod spodem.
function heroBannerHtml() {
  return `
    <div class="hero-banner">
      <img src="./assets/hero.webp" alt="Wóda! Szlugi! Grube baby!"
        fetchpriority="high" width="1600" height="533" />
    </div>`;
}

function headerHtml() {
  const tabs = VIEWS.filter(
    (v) => (!v.adminOnly || isAdmin()) && (!v.authOnly || state.user)
  )
    .map(
      (v) =>
        `<button class="tab ${state.view === v.id ? "active" : ""}" data-view="${v.id}">${v.label}</button>`
    )
    .join("");

  const account = state.user
    ? `<div class="account">
         ${avatarHtml(myProfile(), "sm")}
         <span class="who">${escapeHtml(myProfile().name)}</span>
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
    case "profile":
      return profileHtml();
    case "rules":
      return rulesHtml();
    case "admin":
      return isAdmin() ? adminHtml() : `<p class="muted">Brak dostępu.</p>`;
    default:
      return "";
  }
}

// --- Widok: Czat --------------------------------------------------------------
// Czas wiadomości: "DD.MM HH:MM" (lub "teraz", gdy serwer jeszcze nie nadał czasu).
function fmtChatTime(ts) {
  if (!ts || typeof ts.toDate !== "function") return "teraz";
  return new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(ts.toDate());
}

// Zamienia tekst na bezpieczny HTML: linki klikalne, a linki do obrazków/GIF-ów
// renderowane jako podgląd. Bez osadzania wideo.
function renderMessageText(text) {
  const esc = escapeHtml(text || "");
  return esc.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    const clean = url.replace(/[.,!?)]+$/, ""); // bez końcowej interpunkcji
    if (/\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i.test(clean)) {
      return `<a href="${clean}" target="_blank" rel="noopener noreferrer" class="chat-media-link"><img class="chat-img-inline" src="${clean}" alt="" loading="lazy" /></a>`;
    }
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>`;
  });
}

function chatMessagesHtml() {
  if (!state.chat.length) {
    return `<p class="chat-empty muted">Cisza jak makiem zasiał… Rzuć pierwszym tekstem. 💬</p>`;
  }
  return state.chat
    .map((m) => {
      const mine = state.user && m.uid === state.user.uid;
      const canDel = mine || isAdmin();
      const prof = { name: m.name, avatar: m.avatar, photo: m.photo };
      const body =
        (m.text ? `<div class="chat-text">${renderMessageText(m.text)}</div>` : "") +
        (m.image ? `<a href="${m.image}" target="_blank" rel="noopener"><img class="chat-img" src="${m.image}" alt="" loading="lazy" /></a>` : "");
      return `
        <div class="chat-msg ${mine ? "mine" : ""}">
          ${avatarHtml(prof, "sm")}
          <div class="chat-bubble">
            <div class="chat-head">
              <span class="chat-name">${escapeHtml(m.name || "Gracz")}</span>
              <span class="chat-time">${fmtChatTime(m.createdAt)}</span>
              ${canDel ? `<button class="chat-del" data-id="${escapeHtml(m.id)}" title="Usuń">✕</button>` : ""}
            </div>
            ${body}
          </div>
        </div>`;
    })
    .join("");
}

// HTML pola pisania (zależne od zalogowania).
function chatComposerHtml() {
  if (!state.user) {
    return `<div class="chat-login">
        <p class="muted small">Zaloguj się, żeby pisać.</p>
        <button class="btn primary tiny" id="cw-login"><span class="g-dot"></span> Zaloguj przez Google</button>
      </div>`;
  }
  return `
    <div id="cw-attach"></div>
    <div class="chat-input-row">
      <button type="button" class="btn ghost chat-photo" id="cw-photo" title="Dodaj zdjęcie">📷</button>
      <input type="text" id="cw-text" maxlength="1000" autocomplete="off"
        placeholder="Napisz coś… (wklej link do GIF-a/zdjęcia)" value="${escapeHtml(state.chatDraft)}" />
      <button type="button" class="btn primary" id="cw-send">Wyślij</button>
    </div>
    <input type="file" id="cw-file" accept="image/*" hidden />
    <p class="chat-hint muted small">GIF: skopiuj „link do GIF-a" z Tenora/Giphy i wklej tutaj. Bez filmów.</p>`;
}

function chatAttachHtml() {
  if (!state.chatImage) return "";
  return `<div class="chat-attach"><img src="${state.chatImage}" alt="" /><button type="button" id="cw-attach-remove" title="Usuń">✕</button></div>`;
}

// Odśwież podgląd załączonego zdjęcia (bez ruszania pola tekstowego).
function updateChatAttach() {
  const area = document.getElementById("cw-attach");
  if (!area) return;
  area.innerHTML = chatAttachHtml();
  const rm = document.getElementById("cw-attach-remove");
  if (rm) rm.addEventListener("click", () => { state.chatImage = null; updateChatAttach(); });
}

// Liczba nieprzeczytanych (nowsze niż ostatni odczyt i nie moje).
function unreadCount() {
  return state.chat.reduce((n, m) => {
    const t = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0;
    const mine = state.user && m.uid === state.user.uid;
    return n + (t > (state.chatLastRead || 0) && !mine ? 1 : 0);
  }, 0);
}

function updateChatBadge() {
  const badge = document.querySelector("#chat-widget .chat-badge");
  if (!badge) return;
  const n = unreadCount();
  badge.textContent = n > 9 ? "9+" : String(n);
  badge.style.display = n > 0 ? "" : "none";
  const fab = document.querySelector("#chat-widget .chat-fab");
  if (fab) fab.classList.toggle("has-unread", n > 0);
}

function markChatRead() {
  let max = state.chatLastRead || 0;
  for (const m of state.chat) {
    const t = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0;
    if (t > max) max = t;
  }
  state.chatLastRead = max;
  try { localStorage.setItem("chatLastRead", String(max)); } catch (_) {}
  updateChatBadge();
}

// Buduje pole pisania i podpina zdarzenia (raz; przy zmianie zalogowania na nowo).
function renderChatComposer(w) {
  const wrap = w.querySelector(".chat-composer-wrap");
  wrap.dataset.logged = String(!!state.user);
  wrap.innerHTML = chatComposerHtml();
  const text = wrap.querySelector("#cw-text");
  if (text) {
    text.addEventListener("input", () => { state.chatDraft = text.value; });
    text.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendChatMessage(); }
    });
    // Po otwarciu klawiatury: dopasuj panel i przewiń do ostatniej wiadomości.
    text.addEventListener("focus", () => {
      setTimeout(() => {
        positionChatPanel();
        const l = document.querySelector("#chat-widget #chat-messages");
        if (l) l.scrollTop = l.scrollHeight;
      }, 80);
    });
  }
  const send = wrap.querySelector("#cw-send");
  if (send) send.addEventListener("click", sendChatMessage);
  const photo = wrap.querySelector("#cw-photo");
  const file = wrap.querySelector("#cw-file");
  if (photo && file) photo.addEventListener("click", () => file.click());
  if (file)
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      file.value = "";
      if (f) attachChatPhoto(f);
    });
  const login = wrap.querySelector("#cw-login");
  if (login) login.addEventListener("click", doLogin);
  updateChatAttach();
}

// Doczepia pływający dymek czatu do <body> (raz). Niezależny od render() —
// otwieranie/zamykanie NIE rusza strony pod spodem (wraca w tym samym stanie).
function mountChatWidget() {
  if (document.getElementById("chat-widget")) return;
  try {
    state.chatLastRead = Number(localStorage.getItem("chatLastRead") || 0);
  } catch (_) {}
  // Pierwsza wizyta: traktuj dotychczasowe wiadomości jako przeczytane.
  if (!state.chatLastRead) {
    state.chatLastRead = Date.now();
    try { localStorage.setItem("chatLastRead", String(state.chatLastRead)); } catch (_) {}
  }

  const w = document.createElement("div");
  w.id = "chat-widget";
  w.className = "chat-widget";
  w.innerHTML = `
    <div class="chat-panel">
      <div class="chat-panel-head">
        <span class="chat-panel-title">💬 Czat — Mordoryje</span>
        <button type="button" class="chat-close" id="cw-close" title="Zwiń">✕</button>
      </div>
      <div id="chat-messages" class="chat-messages"></div>
      <div class="chat-composer-wrap"></div>
    </div>
    <button type="button" class="chat-fab" id="cw-fab" aria-label="Czat">
      <span class="chat-fab-icon">💬</span>
      <span class="chat-badge" style="display:none">0</span>
    </button>`;
  document.body.appendChild(w);

  w.querySelector("#cw-fab").addEventListener("click", () => toggleChat());
  w.querySelector("#cw-close").addEventListener("click", () => toggleChat(false));
  // Usuwanie wiadomości (delegacja — nie trzeba podpinać po każdym odświeżeniu).
  w.querySelector("#chat-messages").addEventListener("click", async (e) => {
    const del = e.target.closest && e.target.closest(".chat-del");
    if (!del) return;
    if (!confirm("Usunąć tę wiadomość?")) return;
    try {
      await deleteDoc(doc(db, "chat", del.dataset.id));
    } catch (err) {
      console.error("chat delete:", err);
      alert("Nie udało się usunąć wiadomości.");
    }
  });

  renderChatComposer(w);
  updateChatWidget();
}

// Dopasowanie panelu czatu nad klawiaturą (mobile) przez VisualViewport API —
// żeby pole pisania siedziało tuż nad klawiaturą, a ostatnia wiadomość nad polem.
function resetChatPanelPosition() {
  const p = document.querySelector("#chat-widget .chat-panel");
  if (p) {
    p.style.bottom = "";
    p.style.height = "";
    p.style.top = "";
  }
}
function positionChatPanel() {
  const w = document.getElementById("chat-widget");
  if (!w || !state.chatOpen) return;
  const panel = w.querySelector(".chat-panel");
  if (!panel) return;
  const vv = window.visualViewport;
  if (window.innerWidth > 560 || !vv) {
    resetChatPanelPosition(); // desktop — układ z CSS
    return;
  }
  const margin = 8;
  const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  panel.style.top = "auto";
  panel.style.bottom = keyboard + margin + "px";
  panel.style.height = vv.height - margin * 2 + "px";
  // Gdy klawiatura otwarta — trzymaj się dołu (ostatnia wiadomość nad polem).
  if (keyboard > 0) {
    const list = w.querySelector("#chat-messages");
    if (list) list.scrollTop = list.scrollHeight;
  }
}
let chatVVHandler = null;
function attachChatViewportSync() {
  if (!window.visualViewport || chatVVHandler) return;
  chatVVHandler = () => positionChatPanel();
  window.visualViewport.addEventListener("resize", chatVVHandler);
  window.visualViewport.addEventListener("scroll", chatVVHandler);
}
function detachChatViewportSync() {
  if (!window.visualViewport || !chatVVHandler) return;
  window.visualViewport.removeEventListener("resize", chatVVHandler);
  window.visualViewport.removeEventListener("scroll", chatVVHandler);
  chatVVHandler = null;
}

function toggleChat(force) {
  state.chatOpen = typeof force === "boolean" ? force : !state.chatOpen;
  const w = document.getElementById("chat-widget");
  if (!w) return;
  w.classList.toggle("open", state.chatOpen);
  if (state.chatOpen) {
    const list = w.querySelector("#chat-messages");
    if (list) list.innerHTML = chatMessagesHtml();
    positionChatPanel();
    if (list) list.scrollTop = list.scrollHeight;
    markChatRead();
    attachChatViewportSync();
    // Na desktopie od razu fokus; na telefonie nie wymuszamy klawiatury (czyta).
    if (window.innerWidth > 560) {
      const ti = w.querySelector("#cw-text");
      if (ti) ti.focus();
    }
  } else {
    detachChatViewportSync();
    resetChatPanelPosition();
    updateChatBadge();
  }
}

// Odśwież widget po zmianie danych/zalogowania (NIE rusza pola pisania, gdy
// zalogowanie bez zmian — żeby nie gubić wpisywanego tekstu).
function updateChatWidget() {
  const w = document.getElementById("chat-widget");
  if (!w) return;
  const wrap = w.querySelector(".chat-composer-wrap");
  if (wrap && wrap.dataset.logged !== String(!!state.user)) renderChatComposer(w);
  if (state.chatOpen) {
    const list = w.querySelector("#chat-messages");
    if (list) {
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
      list.innerHTML = chatMessagesHtml();
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
    markChatRead();
  } else {
    updateChatBadge();
  }
}

// Skompresuj wybrane zdjęcie do data URL (max 900 px, JPEG) — by zmieściło się
// w dokumencie Firestore (bez Firebase Storage).
function compressImageToDataUrl(file, maxDim = 900, quality = 0.6) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("bad image"));
    };
    img.src = url;
  });
}

async function attachChatPhoto(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    alert('To nie jest zdjęcie. Filmów nie wysyłamy.');
    return;
  }
  if (/gif/i.test(file.type)) {
    // GIF-y z pliku bywają ogromne — w trybie bez Storage prosimy o link.
    alert('GIF-a wrzuć przez link — w Tenor/Giphy użyj „Kopiuj link do GIF-a” i wklej w polu tekstowym.');
    return;
  }
  try {
    let dataUrl = await compressImageToDataUrl(file, 900, 0.6);
    // Awaryjnie zmniejsz jeszcze, gdyby wyszło za duże dla dokumentu Firestore.
    if (dataUrl.length > 720000) dataUrl = await compressImageToDataUrl(file, 700, 0.5);
    if (dataUrl.length > 900000) {
      alert("To zdjęcie jest za duże. Wybierz mniejsze albo wklej linkiem.");
      return;
    }
    state.chatImage = dataUrl;
    updateChatAttach();
  } catch (_) {
    alert("Nie udało się wczytać tego zdjęcia.");
  }
}

async function sendChatMessage() {
  if (!state.user) return;
  const text = (state.chatDraft || "").trim();
  const image = state.chatImage || null;
  if (!text && !image) return;
  const mp = myProfile();
  try {
    await addDoc(collection(db, "chat"), {
      uid: state.user.uid,
      name: mp.name,
      avatar: mp.avatar || null,
      photo: state.user.photoURL || null,
      text: text.slice(0, 1000),
      image,
      createdAt: serverTimestamp()
    });
    state.chatDraft = "";
    state.chatImage = null;
    const ti = document.getElementById("cw-text");
    if (ti) {
      ti.value = "";
      ti.focus();
    }
    updateChatAttach();
    updateChatWidget();
  } catch (e) {
    console.error("chat send:", e);
    alert('Nie udało się wysłać. Czy reguły Firestore dla kolekcji „chat” są opublikowane?');
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
            const prof = state.predictions[r.uid] || { name: r.name };
            return `
            <tr class="${me ? "me" : ""}">
              <td class="rank">${medal}</td>
              <td class="name">
                <span class="player-cell">
                  ${avatarHtml(prof)}
                  <span class="player-name">${escapeHtml(r.name)}${me ? ' <span class="you">Ty</span>' : ""}</span>
                </span>
              </td>
              <td class="total"><strong>${r.total}</strong></td>
              <td>${r.exactPoints}<span class="cnt">×${r.exactCount}</span></td>
              <td>${r.outcomePoints}<span class="cnt">×${r.outcomeOnlyCount}</span></td>
              <td>${r.advancePoints}<span class="cnt">×${r.advanceCount}</span></td>
              <td>${r.championPoints}</td>
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
          ${p.exactScore} pkt dokładny wynik · ${p.correctResult} pkt traf. rezultat · 🎯 ${p.advanceBonus ?? 1} pkt awans (puchary) · ${p.tournamentWinner} pkt mistrz
        </div>
      </div>
      ${
        !state.user && board.length
          ? `<div class="join-cta">
               🔥 <strong>${board.length}</strong> ${board.length === 1 ? "gracz już typuje" : "graczy już typuje"} — nie zostań w plecy!
               <button class="btn primary tiny" id="login-3">Zaloguj się i dołącz</button>
             </div>`
          : ""
      }
      <div class="card table-card">
        <table class="leaderboard">
          <thead>
            <tr>
              <th>#</th><th>Gracz</th><th>Suma</th>
              <th title="Punkty za dokładne wyniki">Dokł.</th>
              <th title="Punkty za trafione rezultaty (1/X/2)">Rez.</th>
              <th title="Bonus za wskazanie drużyny awansującej (po remisie w 90')">🎯</th>
              <th title="Punkty za zwycięzcę turnieju">Mistrz</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="muted small" style="margin:0 0.2rem">
        Przy remisie decyduje kolejno: więcej dokładnych wyników → trafiony mistrz →
        więcej rezultatów → jak daleko zaszedł typowany mistrz.
      </p>
    </section>`;
}

// Wiersz meczu w stylu Flashscore (tylko podgląd: wynik + mój typ).
function fsMatchRow(m) {
  const r = getResult(m);
  const finished = Boolean(r);
  const myPred = state.user ? state.predictions[state.user.uid]?.matches?.[m.id] : null;
  const hs = r ? r.h : "";
  const as = r ? r.a : "";
  const winH = finished && r.h > r.a;
  const winA = finished && r.a > r.h;
  return `
    <div class="fs-row ${finished ? "fin" : ""}">
      <div class="fs-meta">
        <span class="fs-time">${fmtShort(m.kickoffAt)}</span>
        ${liveTag(m)}
      </div>
      <div class="fs-teams">
        <div class="fs-team ${winH ? "win" : ""}">
          <span class="fs-name"><span class="fs-flag">${flagImg(m.homeTeam)}</span><span class="t">${escapeHtml(m.homeTeam.name)}</span></span>
          <b class="fs-score">${hs}</b>
        </div>
        <div class="fs-team ${winA ? "win" : ""}">
          <span class="fs-name"><span class="fs-flag">${flagImg(m.awayTeam)}</span><span class="t">${escapeHtml(m.awayTeam.name)}</span></span>
          <b class="fs-score">${as}</b>
        </div>
      </div>
      <div class="fs-side">${myPredTag(myPred, r)}</div>
    </div>`;
}

// Wiersz do OBSTAWIANIA (Moje typy) — układ Flashscore: każda drużyna w jednym
// wierszu razem z realnym wynikiem i polem Twojego typu.
function betRow(m) {
  const locked = matchLocked(m);
  const pred = state.myDraft.matches[m.id] || {};
  const r = getResult(m);
  const finished = Boolean(r);
  const myp = pred.h !== undefined && pred.a !== undefined ? pred : null;
  const tag = finished ? myPredTag(myp, r, m) : "";
  const isKO = isKnockout(m);

  const teamLine = (team, side) => {
    const val = pred[side] ?? "";
    const real = finished ? r[side] : null;
    const win = finished && (side === "h" ? r.h > r.a : r.a > r.h);
    return `
      <div class="bet-team-row ${win ? "win" : ""}">
        <span class="fs-flag">${flagImg(team)}</span>
        <span class="bet-name">${escapeHtml(team.name)}</span>
        ${finished ? `<b class="real">${real}</b>` : ""}
        <input type="number" min="0" inputmode="numeric" class="score-in"
          data-match="${m.id}" data-side="${side}" value="${val}" ${locked ? "disabled" : ""}
          aria-label="Twój typ — ${escapeHtml(team.name)}" />
      </div>`;
  };

  // Faza pucharowa: dodatkowo wskaż, kto awansuje (liczy się tylko przy remisie w 90').
  const advPick = isKO
    ? `<div class="adv-pick">
         <span class="adv-label">🎯 Jeśli remis — kto awansuje? <span class="muted">(+${state.settings.points.advanceBonus ?? 1} pkt)</span></span>
         <div class="adv-btns">
           <button type="button" class="adv-btn ${pred.adv === "h" ? "sel" : ""}" data-match="${m.id}" data-adv="h" ${locked ? "disabled" : ""}>${escapeHtml(m.homeTeam.name)}</button>
           <button type="button" class="adv-btn ${pred.adv === "a" ? "sel" : ""}" data-match="${m.id}" data-adv="a" ${locked ? "disabled" : ""}>${escapeHtml(m.awayTeam.name)}</button>
         </div>
       </div>`
    : "";

  const etNote =
    isKO && m.duration && m.duration !== "REGULAR" && !finished
      ? `<div class="bet-tag et-note">⏱️ Rozstrzygnięty po dogrywce/karnych — czeka na wynik 90' od admina.</div>`
      : "";

  return `
    <div class="bet-row ${locked ? "locked" : ""} ${finished ? "fin" : ""} ${isKO ? "ko" : ""}">
      <div class="bet-meta">
        <span class="fs-time">${fmtShort(m.kickoffAt)}</span>
        ${liveTag(m)}${locked && !finished ? '<span class="lock-tag">🔒</span>' : ""}
      </div>
      <div class="bet-grid">
        ${teamLine(m.homeTeam, "h")}
        ${teamLine(m.awayTeam, "a")}
      </div>
      ${tag ? `<div class="bet-tag">${tag}</div>` : ""}
      ${advPick}
      ${etNote}
    </div>`;
}

// Przełącznik układu meczów: Wg grup / Wg dat.
function matchViewToggle() {
  const v = state.matchView;
  return `
    <div class="view-toggle" role="tablist" aria-label="Układ meczów">
      <button class="vt ${v === "groups" ? "active" : ""}" data-matchview="groups">🏆 Wg grup</button>
      <button class="vt ${v === "dates" ? "active" : ""}" data-matchview="dates">📅 Wg dat</button>
    </div>`;
}

// Bloki "wg dat" — jeden card na dzień, mecze posortowane chronologicznie.
function dateBlocksHtml(rowFn, listClass) {
  const list = allKnownMatchesSorted();
  if (!list.length) {
    return `<p class="muted">Brak meczów z ustalonymi drużynami — pojawią się, gdy znane będą pary.</p>`;
  }
  return matchesByDate(list)
    .map(
      ([key, label, ms]) => `
      <div class="card group-block">
        <div class="group-head">
          <span class="group-badge date">📅</span>
          <h3>${escapeHtml(capitalize(label))}</h3>
          <span class="ko-count">${ms.length} ${ms.length === 1 ? "mecz" : "mecz."}</span>
        </div>
        <div class="${listClass}">${ms.map(rowFn).join("")}</div>
      </div>`
    )
    .join("");
}

// --- Widok: Mecze -------------------------------------------------------------
function matchesGroupedHtml() {
  const groups = matchesByGroup();
  const groupBlocks = Object.keys(groups)
    .sort()
    .map(
      (g) => `
      <div class="card group-block">
        <div class="group-head"><span class="group-badge">${g}</span><h3>Grupa ${g}</h3></div>
        ${standingsTableHtml(groups[g])}
        <div class="fs-list">${groups[g].map(fsMatchRow).join("")}</div>
      </div>`
    )
    .join("");

  const koBlocks = knockoutByStage()
    .map(([stage, ms]) => {
      const known = ms.filter((m) => isRealTeam(m.homeTeam) && isRealTeam(m.awayTeam));
      const unknown = ms.length - known.length;
      const note = unknown
        ? `<p class="muted small ko-note">⏳ ${unknown} ${unknown === 1 ? "para" : "par"} do wyłonienia — drużyny pojawią się po wcześniejszych meczach.</p>`
        : "";
      return `
      <div class="card group-block">
        <div class="group-head"><span class="group-badge ko">★</span><h3>${escapeHtml(capitalize(stage))}</h3><span class="ko-count">${ms.length} mecz.</span></div>
        ${known.length ? `<div class="fs-list">${known.map(fsMatchRow).join("")}</div>` : ""}
        ${note}
      </div>`;
    })
    .join("");

  return `
    <div class="phase-label">Faza grupowa</div>
    <div class="group-grid">${groupBlocks}</div>
    <div class="phase-label">Faza pucharowa</div>
    <div class="group-grid">${koBlocks}</div>`;
}

function matchesHtml() {
  const body =
    state.matchView === "dates"
      ? `<div class="stack">${dateBlocksHtml(fsMatchRow, "fs-list")}</div>`
      : matchesGroupedHtml();

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Terminarz · wyniki · tabele</div>
          <h2>Mecze</h2>
        </div>
      </div>
      ${matchViewToggle()}
      ${body}
    </section>`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

  const groups = matchesByGroup();
  const groupBlocks = Object.keys(groups)
    .sort()
    .map((g) => {
      const standings = standingsTableHtml(groups[g]);
      return `
      <div class="card group-block">
        <div class="group-head"><span class="group-badge">${g}</span><h3>Grupa ${g}</h3></div>
        <details class="mini-standings">
          <summary>📊 Tabela grupy</summary>
          ${standings || '<p class="muted small">Brak rozegranych meczów.</p>'}
        </details>
        <div class="bet-list">${groups[g].map(betRow).join("")}</div>
      </div>`;
    })
    .join("");

  const koBlocks = knockoutByStage()
    .map(([stage, ms]) => {
      const known = ms.filter((m) => isRealTeam(m.homeTeam) && isRealTeam(m.awayTeam));
      if (!known.length) return "";
      return `
      <div class="card group-block">
        <div class="group-head"><span class="group-badge ko">★</span><h3>${escapeHtml(capitalize(stage))}</h3></div>
        <div class="bet-list">${known.map(betRow).join("")}</div>
      </div>`;
    })
    .join("");

  const champTeam = teamById(state.myDraft.champion);

  return `
    <section class="stack">
      <div class="section-head">
        <div>
          <div class="eyebrow">Zapis dzieje się sam</div>
          <h2>Moje typy</h2>
        </div>
        <div id="save-indicator" class="save-indicator">${escapeHtml(state.saveMsg)}</div>
      </div>

      <div class="card champion-card">
        <div class="champion-left">
          ${champTeam ? `<span class="champ-flag">${flagImg(champTeam, "flag big")}</span>` : '<div class="champ-icon">👑</div>'}
          <div>
            <div class="champ-title">Mistrz turnieju${champTeam ? `: ${escapeHtml(champTeam.name)}` : ""}</div>
            <div class="muted small">+${state.settings.points.tournamentWinner} pkt za trafienie · ${champLocked ? "🔒 zablokowane (koniec 1. kolejki)" : `można zmieniać do końca 1. kolejki${champDeadlineText()}`}</div>
          </div>
        </div>
        <select id="champion-select" ${champLocked ? "disabled" : ""}>
          <option value="">— wybierz —</option>
          ${teamOptions}
        </select>
        ${champLocked ? '<span class="lock-tag">🔒</span>' : ""}
      </div>

      ${matchViewToggle()}
      ${
        state.matchView === "dates"
          ? `<div class="stack">${dateBlocksHtml(betRow, "bet-list")}</div>`
          : `<div class="phase-label">Faza grupowa</div>
             <div class="group-grid">${groupBlocks}</div>
             ${koBlocks ? `<div class="phase-label">Faza pucharowa</div><div class="group-grid">${koBlocks}</div>` : ""}`
      }

      <p class="muted small footnote">
        Mecz zamyka się <strong>5 minut przed</strong> pierwszym gwizdkiem. Pary pucharowe
        pojawią się do obstawiania, gdy znane będą drużyny. Blokady są po stronie aplikacji
        (uczciwa zabawa).
      </p>
    </section>`;
}

// --- Widok: Profil ------------------------------------------------------------
function profileHtml() {
  if (!state.user) return `<p class="muted">Zaloguj się, aby edytować profil.</p>`;
  seedMyDraft();
  const d = state.myDraft;
  const nameLocked = !!d.nameSet;
  const preview = {
    name: d.name,
    avatar: d.avatar,
    photo: state.user.photoURL || null,
    champion: d.champion
  };

  const avatarBtns = avatarOptions()
    .map(
      (url) =>
        `<button type="button" class="avatar-pick ${d.avatar === url ? "sel" : ""}" data-url="${url}">
           <img src="${url}" alt="" loading="lazy" />
         </button>`
    )
    .join("");

  const emojiBtns = AVATAR_EMOJIS.map(
    (e) =>
      `<button type="button" class="emoji-pick ${d.avatar === e ? "sel" : ""}" data-emoji="${e}">${e}</button>`
  ).join("");

  const nickBlock = nameLocked
    ? `<p>Twój nick: <strong>${escapeHtml(d.name)}</strong></p>
       <p class="muted small">🔒 Nick można ustawić tylko raz — jest już zablokowany.</p>`
    : `<p class="muted small">Tak będziesz widoczny w rankingu.
         <strong>Uwaga: nick ustawiasz tylko raz, potem się zablokuje.</strong></p>
       <div class="nick-row">
         <input type="text" id="nick-input" maxlength="24" placeholder="np. Mati"
           value="${escapeHtml(d.name || "")}" />
         <button class="btn primary" id="nick-save">Zapisz nick</button>
       </div>`;

  return `
    <section class="stack">
      <div class="section-head">
        <div><div class="eyebrow">Twoja wizytówka</div><h2>Profil</h2></div>
        <div id="save-indicator" class="save-indicator">${escapeHtml(state.saveMsg)}</div>
      </div>

      <div class="card profile-head">
        ${avatarHtml(preview, "lg")}
        <div>
          <div class="profile-name">${escapeHtml(d.name)}</div>
          <div class="muted small">${escapeHtml(state.user.email)}</div>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">Nick</h3>
        ${nickBlock}
      </div>

      <div class="card">
        <div class="section-head compact">
          <h3 class="card-title">Avatar / zdjęcie profilowe</h3>
          <button class="btn ghost tiny" id="avatar-reroll">🎲 Losuj inne</button>
        </div>
        <p class="muted small">Szybki wybór — emoji:</p>
        <div class="emoji-grid">${emojiBtns}</div>
        <p class="muted small" style="margin-top:0.9rem">…albo wgraj własne zdjęcie, weź z Google lub wklej link.</p>
        <div class="button-row" style="margin-top:0.6rem">
          <button class="btn primary" id="avatar-upload">📷 Wgraj swoje zdjęcie</button>
          ${state.user.photoURL ? '<button class="btn" id="avatar-google">Zdjęcie z Google</button>' : ""}
        </div>
        <input type="file" id="avatar-file" accept="image/*" hidden />
        <div class="avatar-grid" style="margin-top:0.9rem">${avatarBtns}</div>
        <div class="nick-row" style="margin-top:0.9rem">
          <input type="text" id="avatar-url" placeholder="https://… własny link do zdjęcia"
            value="${d.avatar && /^https?:/.test(d.avatar) && !d.avatar.includes("dicebear") ? escapeHtml(d.avatar) : ""}" />
        </div>
        <div class="button-row" style="margin-top:0.8rem">
          <button class="btn ghost" id="avatar-clear">Domyślny (inicjały)</button>
        </div>
      </div>

      <div class="card">
        <h3 class="card-title">🔔 Powiadomienia</h3>
        ${notificationsBlock()}
      </div>
    </section>`;
}

function notificationsBlock() {
  if (!("Notification" in window)) {
    return `<p class="muted small">Twoja przeglądarka nie obsługuje powiadomień.</p>`;
  }
  if (Notification.permission === "granted") {
    return `<p class="muted small">✅ Włączone. Dostaniesz powiadomienie o nowym liderze rankingu
      i o zakończonych meczach (gdy aplikacja jest otwarta / zainstalowana).</p>
      <button class="btn ghost tiny" id="notify-test">Wyślij testowe</button>`;
  }
  if (Notification.permission === "denied") {
    return `<p class="muted small">🚫 Powiadomienia są zablokowane w ustawieniach przeglądarki dla tej strony.
      Odblokuj je w ustawieniach witryny, żeby włączyć.</p>`;
  }
  return `<p class="muted small">Dostawaj info o nowym liderze i wynikach meczów (z komentarzem 😈).</p>
    <button class="btn primary" id="notify-enable">🔔 Włącz powiadomienia</button>`;
}

// --- Jednorazowy popup o powiadomieniach (na ekranie głównym) -----------------
// Pokazuje się RAZ na urządzenie (zapamiętane w localStorage), tylko gdy
// powiadomienia są wspierane i jeszcze nieustawione (permission === "default").
function shouldShowNotifyPrompt() {
  if (!state.user) return false; // dopiero po zalogowaniu (nie zanim ktoś zobaczy co to jest)
  if (state.notifyPromptDone) return false;
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "default") return false;
  if (isInAppBrowser()) return false; // tam i tak nie zadziała (jest osobny baner)
  try {
    if (localStorage.getItem("notifyPromptSeen")) return false;
  } catch (_) {}
  return true;
}

function dismissNotifyPrompt() {
  state.notifyPromptDone = true;
  try {
    localStorage.setItem("notifyPromptSeen", "1");
  } catch (_) {}
}

function notifyPromptHtml() {
  if (!shouldShowNotifyPrompt()) return "";
  return `
    <div class="notify-pop-overlay">
      <div class="notify-pop">
        <div class="notify-pop-emoji">🔔</div>
        <h3>Włącz powiadomienia</h3>
        <p class="muted small">Dostawaj info o nowym liderze rankingu i wynikach meczów prosto na telefon
          — bez spamu, tylko konkrety (z komentarzem 😈). Zawsze zmienisz to w Profilu.</p>
        <div class="notify-pop-actions">
          <button class="btn ghost" id="notify-pop-later">Może później</button>
          <button class="btn primary" id="notify-pop-enable">🔔 Włącz</button>
        </div>
      </div>
    </div>`;
}

// --- Widok: Regulamin ---------------------------------------------------------
function rulesHtml() {
  const p = state.settings.points;
  return `
    <section class="stack">
      <div class="section-head">
        <div><div class="eyebrow">Zasady gry</div><h2>Regulamin</h2></div>
      </div>

      <div class="card">
        <h3 class="card-title">⚽ Punktacja</h3>
        <ul class="rules-list">
          <li><span class="pts ok">${p.exactScore} pkt</span> za <strong>dokładny wynik</strong> meczu (np. typujesz 2:1 i pada 2:1).</li>
          <li><span class="pts ok">${p.correctResult} pkt</span> za trafiony <strong>rezultat</strong> (wygrana gospodarzy / remis / wygrana gości), jeśli wynik nie jest dokładny.</li>
          <li><span class="pts miss">0 pkt</span> za nietrafiony rezultat.</li>
          <li><span class="pts exact">${p.tournamentWinner} pkt</span> za trafienie <strong>zwycięzcy całego turnieju</strong>.</li>
        </ul>
        <p class="muted small">Przy remisie w punktach decyduje kolejno: więcej dokładnych wyników →
        trafiony mistrz → więcej trafionych rezultatów → jak daleko zaszedł typowany mistrz.</p>
      </div>

      <div class="card">
        <h3 class="card-title">⏱️ Zasady typowania</h3>
        <ul class="rules-list">
          <li>Typ meczu można wpisać/zmienić najpóźniej <strong>5 minut przed</strong> pierwszym gwizdkiem.</li>
          <li>Typ na <strong>zwycięzcę turnieju</strong> można zmieniać tylko do <strong>końca 1. kolejki</strong> fazy grupowej.</li>
          <li>Wyniki zaciągają się automatycznie, ranking liczy się na bieżąco.</li>
        </ul>
      </div>

      <div class="card">
        <h3 class="card-title">🏆 Faza pucharowa — czas regulaminowy i awans</h3>
        <ul class="rules-list">
          <li>Typy dotyczą <strong>regulaminowego czasu gry (90 minut)</strong>. Ewentualna
            <strong>dogrywka i karne NIE są kwalifikowane</strong> do punktów za wynik/rezultat
            (mecz po dogrywce admin wpisuje jako wynik z 90').</li>
          <li>Dodatkowo możesz wskazać, <strong>kto awansuje</strong> — przydaje się, gdy typujesz remis,
            bo w dogrywce/karnych ktoś jednak przejdzie dalej.</li>
          <li><span class="pts ok">+${p.advanceBonus ?? 1} pkt</span> za trafioną drużynę awansującą,
            ale <strong>tylko gdy w 90' faktycznie był remis i Ty też typowałeś remis</strong>
            (czyli trafiłeś co najmniej rezultat).</li>
          <li>Jeśli typujesz remis i wskazujesz drużynę A, a drużyna A awansuje przez
            <strong>zwycięstwo w 90'</strong> (nie było remisu) — rezultat nietrafiony,
            <strong>0 pkt</strong> i bonus nie przysługuje.</li>
          <li><strong>Mistrz turnieju</strong> = faktyczny zdobywca pucharu (tu liczy się też dogrywka/karne).</li>
        </ul>
      </div>

      <div class="card prizes-card">
        <h3 class="card-title">🏆 Nagrody — podział puli</h3>
        <div class="podium">
          <div class="prize gold">
            <div class="prize-place">🥇 I miejsce</div>
            <div class="prize-amount">70% puli</div>
          </div>
          <div class="prize silver">
            <div class="prize-place">🥈 II miejsce</div>
            <div class="prize-amount">30% puli</div>
            <div class="prize-note">minus koszt Harnasia zakapslowanego</div>
          </div>
          <div class="prize bronze">
            <div class="prize-place">🥉 III miejsce</div>
            <div class="prize-amount">🍺 Harnaś zakapslowany</div>
          </div>
        </div>
        <p class="muted small">Gra toczy się o punkty i pulę ustaloną w grupie — bez prawdziwego bukmachera,
        kursów i płatności w aplikacji. Rozliczenie puli odbywa się między uczestnikami poza serwisem.</p>
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

  const playerBoard = calculateLeaderboard();
  const playerRows = playerBoard.length
    ? playerBoard
        .map((r) => {
          const prof = state.predictions[r.uid] || { name: r.name };
          const isMe = state.user && r.uid === state.user.uid;
          return `
            <div class="player-row">
              <span class="player-cell">
                ${avatarHtml(prof)}
                <span class="player-id">
                  <span class="player-name">${escapeHtml(r.name)}${isMe ? " (Ty)" : ""}</span>
                  ${prof.email ? `<span class="muted small block">${escapeHtml(prof.email)}</span>` : ""}
                </span>
              </span>
              <span class="player-pts">${r.total} pkt</span>
              <button class="btn ghost tiny del-player" data-uid="${escapeHtml(r.uid)}"
                data-name="${escapeHtml(r.name)}" ${isMe ? "disabled title=\"Nie usuniesz samego siebie\"" : ""}>🗑️</button>
            </div>`;
        })
        .join("")
    : `<p class="muted small">Brak graczy.</p>`;

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
        ⚙️ Bezpiecznik — na co dzień nie musisz tu nic robić. Wyniki meczów i mistrz
        turnieju (zwycięzca finału) liczą się automatycznie z API. Tu wejdziesz tylko,
        gdy API się spóźni lub poda zły wynik — wtedy ręczna wartość nadpisze automat.
      </div>

      <div class="card">
        <div class="section-head compact">
          <h3 class="card-title">👥 Gracze (${playerBoard.length})</h3>
        </div>
        <p class="muted small">Gdyby link gdzieś wyciekł — tu wykopiesz niechcianych.
          Usunięcie kasuje typy gracza <strong>bezpowrotnie</strong> (może wrócić, jeśli zaloguje się ponownie).</p>
        <div class="player-admin-list">${playerRows}</div>
      </div>

      <div class="card champion-card">
        <div class="champion-left">
          <div class="champ-icon">👑</div>
          <div>
            <div class="champ-title">Mistrz turnieju (ręczne nadpisanie)</div>
            <div class="muted small">Zwykle zostaw puste — liczy się automatycznie ze zwycięzcy finału (${state.settings.points.tournamentWinner} pkt). Ustaw tylko, gdy chcesz wymusić inną drużynę.</div>
          </div>
        </div>
        <select id="admin-champion">
          <option value="">— nie rozstrzygnięto —</option>
          ${champOptions}
        </select>
      </div>

      <div class="card">
        <h3 class="card-title">Wyniki meczów</h3>
        <p class="muted small">Faza pucharowa: wpisuj <strong>wynik z 90 minut</strong> (regulaminowy).
          Mecze rozstrzygnięte po dogrywce/karnych nie liczą się automatycznie —
          o awansie decyduje pole „winner" z API (typy „kto awansuje" liczą się same).</p>
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

  // Przełącznik układu meczów: Wg grup / Wg dat
  appRoot.querySelectorAll("[data-matchview]").forEach((b) =>
    b.addEventListener("click", () => {
      state.matchView = b.dataset.matchview;
      render();
    })
  );

  const login = document.getElementById("login");
  const login2 = document.getElementById("login-2");
  const login3 = document.getElementById("login-3");
  if (login) login.addEventListener("click", doLogin);
  if (login2) login2.addEventListener("click", doLogin);
  if (login3) login3.addEventListener("click", doLogin);

  const logout = document.getElementById("logout");
  if (logout) logout.addEventListener("click", () => signOut(auth));

  const openExternal = document.getElementById("open-external");
  if (openExternal) openExternal.addEventListener("click", openInExternalBrowser);

  // Jednorazowy popup o powiadomieniach (ekran główny)
  const notifyPopEnable = document.getElementById("notify-pop-enable");
  if (notifyPopEnable)
    notifyPopEnable.addEventListener("click", () => {
      dismissNotifyPrompt();
      requestNotifyPermission(); // sama wywoła render()
    });
  const notifyPopLater = document.getElementById("notify-pop-later");
  if (notifyPopLater)
    notifyPopLater.addEventListener("click", () => {
      dismissNotifyPrompt();
      render();
    });

  // Profil — powiadomienia
  const notifyEnable = document.getElementById("notify-enable");
  if (notifyEnable) notifyEnable.addEventListener("click", requestNotifyPermission);
  const notifyTest = document.getElementById("notify-test");
  if (notifyTest)
    notifyTest.addEventListener("click", () =>
      notify("⚽ Test powiadomienia", "Działa! Tu wpadną info o liderze i wynikach meczów.")
    );

  // Profil — nick (zmiana tylko raz)
  const nickInput = document.getElementById("nick-input");
  if (nickInput)
    nickInput.addEventListener("input", () => {
      state.myDraft.name = nickInput.value;
    });

  const nickSave = document.getElementById("nick-save");
  if (nickSave)
    nickSave.addEventListener("click", async () => {
      const v = (state.myDraft.name || "").trim();
      if (!v) {
        alert("Wpisz nick.");
        return;
      }
      if (!confirm(`Ustawić nick „${v}"? Później już go nie zmienisz.`)) return;
      state.myDraft.name = v;
      state.myDraft.nameSet = true;
      await saveProfile();
      render();
    });

  // Profil — avatar (emoji)
  appRoot.querySelectorAll(".emoji-pick").forEach((b) =>
    b.addEventListener("click", async () => {
      state.myDraft.avatar = b.dataset.emoji;
      await saveProfile();
      render();
    })
  );

  // Profil — avatar (generowane grafiki)
  appRoot.querySelectorAll(".avatar-pick").forEach((b) =>
    b.addEventListener("click", async () => {
      state.myDraft.avatar = b.dataset.url;
      await saveProfile();
      render();
    })
  );

  const avatarReroll = document.getElementById("avatar-reroll");
  if (avatarReroll)
    avatarReroll.addEventListener("click", () => {
      state.avatarSeed = (state.avatarSeed || 0) + 1;
      render();
    });

  // Wgranie własnego zdjęcia → kadrowanie w kółku
  const avatarUpload = document.getElementById("avatar-upload");
  const avatarFile = document.getElementById("avatar-file");
  if (avatarUpload && avatarFile)
    avatarUpload.addEventListener("click", () => avatarFile.click());
  if (avatarFile)
    avatarFile.addEventListener("change", () => {
      const file = avatarFile.files && avatarFile.files[0];
      avatarFile.value = ""; // reset — by można było wgrać ten sam plik ponownie
      if (file) openAvatarCropper(file);
    });

  const avatarUrl = document.getElementById("avatar-url");
  if (avatarUrl)
    avatarUrl.addEventListener("change", async () => {
      const v = avatarUrl.value.trim();
      state.myDraft.avatar = v || null;
      await saveProfile();
      render();
    });

  const avatarGoogle = document.getElementById("avatar-google");
  if (avatarGoogle)
    avatarGoogle.addEventListener("click", async () => {
      state.myDraft.avatar = state.user.photoURL || null;
      await saveProfile();
      render();
    });

  const avatarClear = document.getElementById("avatar-clear");
  if (avatarClear)
    avatarClear.addEventListener("click", async () => {
      state.myDraft.avatar = "none";
      await saveProfile();
      render();
    });

  // Moje typy — pola wyników
  appRoot.querySelectorAll(".score-in").forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.dataset.match;
      const side = input.dataset.side;
      if (!state.myDraft.matches[id]) state.myDraft.matches[id] = {};
      const v = input.value === "" ? undefined : Math.max(0, Math.trunc(Number(input.value)));
      state.myDraft.matches[id][side] = v;
      // Usuń pusty typ (oba pola puste i bez wskazania awansu)
      const cur = state.myDraft.matches[id];
      if (cur.h === undefined && cur.a === undefined && !cur.adv) delete state.myDraft.matches[id];
      saveMyPredictionsDebounced();
    });
  });

  // Moje typy — wskazanie drużyny awansującej (faza pucharowa)
  appRoot.querySelectorAll(".adv-btn").forEach((b) =>
    b.addEventListener("click", () => {
      const id = b.dataset.match;
      const side = b.dataset.adv;
      if (!state.myDraft.matches[id]) state.myDraft.matches[id] = {};
      const cur = state.myDraft.matches[id];
      cur.adv = cur.adv === side ? undefined : side; // ponowne kliknięcie = odznacz
      if (cur.h === undefined && cur.a === undefined && !cur.adv) delete state.myDraft.matches[id];
      saveMyPredictionsDebounced();
      render();
    })
  );

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

  // Panel admina — usuwanie graczy
  appRoot.querySelectorAll(".del-player").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!isAdmin()) return;
      const uid = b.dataset.uid;
      const name = b.dataset.name || "tego gracza";
      if (uid === state.user?.uid) return; // nie usuwamy siebie
      if (!confirm(`Usunąć gracza „${name}"? Jego typy znikną bezpowrotnie.`)) return;
      try {
        await deleteDoc(doc(db, "predictions", uid));
        // onSnapshot sam odświeży listę i ranking
      } catch (e) {
        console.error("delete player:", e);
        alert("Nie udało się usunąć. Sprawdź, czy reguły Firestore pozwalają adminowi na delete (trzeba je opublikować w konsoli).");
      }
    })
  );
}

// Przeglądarki wbudowane w aplikacje (Messenger, Facebook, Instagram, TikTok…).
// Google CELOWO blokuje w nich logowanie OAuth ("disallowed_useragent") —
// objawia się to białym ekranem na firebaseapp.com. Trzeba otworzyć w Chrome/Safari.
function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /FBAN|FBAV|FB_IAB|FBIOS|Instagram|Messenger|MicroMessenger|Line\/|Snapchat|TikTok|musical_ly|Twitter|Pinterest|GSA\//i.test(
    ua
  );
}

// Próba wyrwania się z webview do zewnętrznej przeglądarki.
function openInExternalBrowser() {
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) {
    // Android: wymuś otwarcie w Chrome przez intent.
    const noScheme = location.href.replace(/^https?:\/\//, "");
    location.href =
      "intent://" + noScheme + "#Intent;scheme=https;package=com.android.chrome;end";
    return;
  }
  // iOS / reszta: nie da się wymusić — kopiujemy link i prosimy o otwarcie ręczne.
  copyAppLink();
}

function copyAppLink() {
  const url = location.href;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => alert("Skopiowano link 👍\nWklej go w Chrome lub Safari i tam się zaloguj."))
      .catch(() => alert("Otwórz ten adres w Chrome / Safari:\n" + url));
  } else {
    alert("Otwórz ten adres w Chrome / Safari:\n" + url);
  }
}

async function doLogin() {
  // W przeglądarce Messengera/FB/IG logowanie Google nie zadziała — kieruj na zewnątrz.
  if (isInAppBrowser()) {
    openInExternalBrowser();
    return;
  }
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (e) {
    console.error(e);
    // Na mobilkach popup bywa blokowany — wtedy próbujemy przez przekierowanie.
    if (
      e.code === "auth/popup-blocked" ||
      e.code === "auth/cancelled-popup-request" ||
      e.code === "auth/operation-not-supported-in-this-environment"
    ) {
      try {
        await signInWithRedirect(auth, googleProvider);
        return;
      } catch (e2) {
        console.error(e2);
      }
    }
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
    nameSet: !!mine?.nameSet,
    avatar: mine?.avatar || null,
    matches: structuredClone(mine?.matches || {}),
    champion: mine?.champion || null
  };
  state.myDraftSeededFor = state.user.uid;
}

// =============================================================================
//  POWIADOMIENIA (in-app — gdy aplikacja jest otwarta/zainstalowana)
// =============================================================================

async function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = {
    body,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    tag: title + body
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg && reg.showNotification) reg.showNotification(title, opts);
    else new Notification(title, opts);
  } catch (e) {
    try { new Notification(title, opts); } catch (_) {}
  }
}

async function requestNotifyPermission() {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
  } catch (_) {}
  render();
  if (Notification.permission === "granted") {
    notify("🔔 Powiadomienia włączone", "Teraz nie ucieknie Ci żadna akcja. Powodzenia, typerze!");
    subscribePush();
  }
}

// Subskrypcja prawdziwego push (Web Push / VAPID) — zapisuje subskrypcję w bazie,
// żeby robot mógł wysłać powiadomienie nawet przy zamkniętej aplikacji.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function subscribePush() {
  try {
    if (!state.user) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC)
      });
    }
    await setDoc(
      doc(db, "pushSubs", state.user.uid),
      {
        sub: JSON.parse(JSON.stringify(sub)),
        name: myProfile().name,
        email: state.user.email,
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );
  } catch (e) {
    console.warn("push subscribe:", e);
  }
}

function rand(arr) {
  // bez Math.random() (stabilność) — wybór zależny od długości danych
  return arr[(state.notifiedFinished.size + state.matches.length) % arr.length];
}

function notifyMatchFinished(m) {
  const r = getResult(m);
  if (!r) return;
  const score = `${r.h}:${r.a}`;
  const title = `⚽ ${m.homeTeam.name} ${r.h}:${r.a} ${m.awayTeam.name}`;

  // Komentarz dotyczy TWOJEGO typu na ten mecz.
  const mine = state.user ? state.predictions[state.user.uid]?.matches?.[m.id] : null;
  let body;
  if (!state.user) {
    body = `Wynik: ${score}. Zaloguj się i typuj, bo tracisz zabawę!`;
  } else if (!mine) {
    body = rand([
      `Wynik ${score}, a Ty nawet nie obstawiłeś. Wstyd, mordo.`,
      `${score} po gwizdku. Twojego typu brak — śpisz czy co?`
    ]);
  } else {
    const s = scoreMatch(mine, r, state.settings);
    if (s.exact) {
      body = rand([
        `JA PIERDOLĘ! Dokładny wynik ${score} trafiony! +${s.points} pkt, ty jasnowidzu!`,
        `Co za nos! Strzeliłeś ${score} co do bramki. +${s.points} pkt, gratulacje!`
      ]);
    } else if (s.correct) {
      body = rand([
        `Rezultat trafiony, +${s.points} pkt do kieszeni. Mogło być lepiej, ale jest.`,
        `Nieźle — rezultat siadł, +${s.points} pkt. Dokładny wynik następnym razem.`
      ]);
    } else {
      body = rand([
        `Chuja trafiłeś i chuja dostałeś. 0 pkt. Następnym razem rusz głową.`,
        `Pudło na całej linii. 0 pkt. Może rzut monetą zadziała lepiej?`
      ]);
    }
  }
  notify(title, body);
}

function notifyNewLeader(row) {
  if (!row) return;
  const me = state.user && row.uid === state.user.uid;
  const title = "👑 Nowy lider rankingu!";
  const body = me
    ? `Jesteś nowym liderem, ${row.name}! Tylko tego nie spierdol.`
    : `${row.name} wskakuje na 1. miejsce i depcze wam po pysku. Ktoś to ogarnie?`;
  notify(title, body);
}

// Po każdej aktualizacji danych: sprawdź, czy jest o czym powiadomić.
function checkNotifications() {
  const board = calculateLeaderboard();
  const leader = board[0]?.uid || null;

  if (!state.notifyInit) {
    // pierwszy przebieg — tylko zapamiętaj stan, bez powiadomień
    state.notifiedFinished = new Set(state.matches.filter(matchFinished).map((m) => m.id));
    state.lastLeaderUid = leader;
    state.notifyInit = true;
    return;
  }

  for (const m of state.matches) {
    if (matchFinished(m) && !state.notifiedFinished.has(m.id)) {
      state.notifiedFinished.add(m.id);
      notifyMatchFinished(m);
    }
  }

  if (leader && leader !== state.lastLeaderUid) {
    state.lastLeaderUid = leader;
    notifyNewLeader(board[0]);
  }
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
        checkNotifications();
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
        checkNotifications();
        maybeRender();
      },
      (err) => console.error("admin/state:", err.message)
    )
  );

  // Czat — ostatnie wiadomości (najnowsze na dole).
  unsubscribers.push(
    onSnapshot(
      query(collection(db, "chat"), orderBy("createdAt", "desc"), limit(80)),
      (snap) => {
        const arr = [];
        snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
        arr.reverse(); // najstarsze na górze
        state.chat = arr;
        updateChatWidget();
      },
      (err) => console.error("chat:", err.message)
    )
  );
}

function stopListening() {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
}

// Po zalogowaniu twórz minimalny wpis gracza, jeśli go jeszcze nie ma — dzięki
// temu każdy zalogowany od razu pojawia się w rankingu (nawet zanim zacznie
// typować). NIE nadpisuje istniejących danych (tylko gdy dokumentu brak).
async function ensureProfileDoc(user) {
  try {
    const ref = doc(db, "predictions", user.uid);
    const snap = await getDoc(ref);
    if (snap.exists()) return;
    await setDoc(ref, {
      name: user.displayName || user.email,
      nameSet: false,
      avatar: null,
      photo: user.photoURL || null,
      email: user.email,
      joinedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  } catch (e) {
    console.error("ensureProfileDoc:", e);
  }
}

onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.myDraft = null;
  state.myDraftSeededFor = null;

  // Ranking jest PUBLICZNY — listener startuje też bez logowania (idempotentny).
  listenToFirestore();

  if (user) {
    ensureProfileDoc(user);
    if ("Notification" in window && Notification.permission === "granted") subscribePush();
  }

  // Jeśli admin się wylogował z widoku admina — wróć do rankingu
  if (state.view === "admin" && !isAdmin()) state.view = "ranking";
  render();
});

// Rejestracja service workera (instalacja jako aplikacja + powiadomienia).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("SW:", e));
}

// Cykliczne odświeżanie wyników z pliku (robot aktualizuje go co 30 min),
// żeby przy otwartej aplikacji wpadały powiadomienia o zakończonych meczach.
function startMatchesPolling() {
  setInterval(async () => {
    try {
      const matches = await fetch(`./data/matches.json?ts=${Date.now()}`).then((r) => r.json());
      state.matches = [...matches].sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
      checkNotifications();
      if (state.view === "matches" || state.view === "ranking") render();
    } catch (_) {}
  }, 5 * 60 * 1000);
}

// --- Start --------------------------------------------------------------------
(async function start() {
  try {
    await loadStaticData();
    render();
    startMatchesPolling();
  } catch (e) {
    console.error(e);
    appRoot.innerHTML = `<div class="boot error">Nie udało się wczytać danych (data/*.json).<br>${escapeHtml(
      e.message || ""
    )}</div>`;
  }
})();
