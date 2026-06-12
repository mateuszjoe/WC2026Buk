// =============================================================================
//  ROBOT: pobiera terminarz i wyniki MŚ 2026 z football-data.org i zapisuje je
//  do data/matches.json. Jeśli ustawisz API_FOOTBALL_KEY/API_SPORTS_KEY, dociąga
//  też live-score z API-Football (API-Sports) dla trwających meczów.
//
//  Token API czytany jest z sekretu FOOTBALL_DATA_TOKEN (ustawiany w repo na
//  GitHubie). NIE wpisuj tokenu do kodu.
// =============================================================================

import { writeFile, readFile, rm } from "node:fs/promises";
import admin from "firebase-admin";

// Chwilowe bledy (np. "fetch failed: other side closed" — zerwane polaczenie z API)
// NIE moga psuc joba — inaczej GitHub Actions slalby maile o nieudanym przebiegu.
// Lapiemy je i konczymy SUKCESEM (exit 0), zostawiajac ostatni dobry terminarz.
process.on("unhandledRejection", (e) => {
  console.warn("Chwilowy blad (unhandledRejection):", e?.message || e);
  console.warn("Pomijam aktualizacje — zostaje ostatnia dobra wersja.");
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  console.warn("Chwilowy blad (uncaughtException):", e?.message || e);
  process.exit(0);
});

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error("Brak FOOTBALL_DATA_TOKEN. Dodaj sekret w repo: Settings → Secrets → Actions.");
  process.exit(1);
}
const API_FOOTBALL_KEY =
  process.env.API_FOOTBALL_KEY || process.env.API_SPORTS_KEY || process.env.APISPORTS_KEY || "";
const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const WORLD_CUP_LEAGUE_ID = 1;
const WORLD_CUP_SEASON = 2026;

// Polskie nazwy reprezentacji (fallback: oryginalna nazwa z API).
const PL_NAMES = {
  Poland: "Polska", Mexico: "Meksyk", Canada: "Kanada", "United States": "USA",
  Morocco: "Maroko", Japan: "Japonia", Argentina: "Argentyna",
  "Korea Republic": "Korea Płd.", "South Korea": "Korea Płd.", France: "Francja",
  Croatia: "Chorwacja", Brazil: "Brazylia", Netherlands: "Holandia",
  England: "Anglia", Senegal: "Senegal", Spain: "Hiszpania", Portugal: "Portugalia",
  Germany: "Niemcy", Italy: "Włochy", Belgium: "Belgia", Switzerland: "Szwajcaria",
  Denmark: "Dania", Sweden: "Szwecja", Norway: "Norwegia", Austria: "Austria",
  Serbia: "Serbia", Ukraine: "Ukraina", Wales: "Walia", Scotland: "Szkocja",
  "Czech Republic": "Czechy", Czechia: "Czechy", Turkey: "Turcja", Türkiye: "Turcja",
  Greece: "Grecja", Hungary: "Węgry", Ireland: "Irlandia", Slovakia: "Słowacja",
  Slovenia: "Słowenia", Romania: "Rumunia", Russia: "Rosja",
  Uruguay: "Urugwaj", Colombia: "Kolumbia", Chile: "Chile", Peru: "Peru",
  Ecuador: "Ekwador", Paraguay: "Paragwaj", Venezuela: "Wenezuela", Bolivia: "Boliwia",
  "Costa Rica": "Kostaryka", Panama: "Panama", Honduras: "Honduras", Jamaica: "Jamajka",
  Egypt: "Egipt", Nigeria: "Nigeria", Ghana: "Ghana", Cameroon: "Kamerun",
  "Ivory Coast": "Wybrzeże Kości Słoniowej", "Côte d'Ivoire": "Wybrzeże Kości Słoniowej",
  Algeria: "Algieria", Tunisia: "Tunezja", "South Africa": "RPA",
  "Cape Verde": "Republika Zielonego Przylądka", "Cape Verde Islands": "Republika Zielonego Przylądka",
  Australia: "Australia", "New Zealand": "Nowa Zelandia", "Saudi Arabia": "Arabia Saudyjska",
  Iran: "Iran", "IR Iran": "Iran", Qatar: "Katar", Iraq: "Irak", Jordan: "Jordania",
  "United Arab Emirates": "ZEA", Uzbekistan: "Uzbekistan",
  "Bosnia-Herzegovina": "Bośnia i Hercegowina", "Bosnia and Herzegovina": "Bośnia i Hercegowina",
  "Congo DR": "DR Konga", "DR Congo": "DR Konga", "Curaçao": "Curaçao", Haiti: "Haiti",
  "New Caledonia": "Nowa Kaledonia", Panama: "Panama"
};

function plName(name) {
  if (!name) return "TBD";
  return PL_NAMES[name] || name;
}

// Mapowanie etapu z API na czytelną nazwę.
function stagePl(stage) {
  const map = {
    GROUP_STAGE: "group",
    LAST_32: "1/16 finału",
    LAST_16: "1/8 finału",
    QUARTER_FINALS: "ćwierćfinał",
    SEMI_FINALS: "półfinał",
    THIRD_PLACE: "mecz o 3. miejsce",
    FINAL: "finał"
  };
  return map[stage] || stage;
}

function scorePart(part) {
  if (!part) return { home: null, away: null };
  const home =
    typeof part.home === "number"
      ? part.home
      : typeof part.homeTeam === "number"
      ? part.homeTeam
      : null;
  const away =
    typeof part.away === "number"
      ? part.away
      : typeof part.awayTeam === "number"
      ? part.awayTeam
      : null;
  return { home, away };
}

function ymdUtc(d) {
  return d.toISOString().slice(0, 10);
}

function normalizeName(name) {
  return plName(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function closeKickoff(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 3 * 60 * 60 * 1000;
}

// Okno meczu: od 15 min przed pierwszym gwizdkiem do 150 min po. W tym czasie
// dociągamy live-score i — w workflow — zapętlamy pollowanie. Węższe niż kiedyś
// (było +4 h), żeby oszczędzać dzienny limit zapytań API-Football (free = 100/dzień).
const LIVE_WINDOW_BEFORE_MS = 15 * 60 * 1000;
const LIVE_WINDOW_AFTER_MS = 150 * 60 * 1000;
// ESPN pytamy DŁUŻEJ po meczu (8 h) niż trwa pętla (150 min), żeby na pewno
// złapać i utrwalić wynik końcowy — football-data.org free nie podaje go w trakcie,
// a po zamknięciu okna nie wolno cofnąć zakończonego meczu do TIMED (sticky finals).
const ESPN_WINDOW_AFTER_MS = 8 * 60 * 60 * 1000;

function inWindow(m, afterMs, now) {
  const t = Date.parse(m.kickoffAt);
  if (!Number.isFinite(t)) return false;
  return now >= t - LIVE_WINDOW_BEFORE_MS && now <= t + afterMs;
}

// Okno pętli/flagi (krótkie): od 15 min przed do 150 min po gwizdku.
function isInLiveWindow(matches, now = Date.now()) {
  return matches.some((m) => inWindow(m, LIVE_WINDOW_AFTER_MS, now));
}

// Okno odpytywania ESPN (długie): do 8 h po gwizdku — żeby utrwalić finał.
function isInEspnWindow(matches, now = Date.now()) {
  return matches.some((m) => inWindow(m, ESPN_WINDOW_AFTER_MS, now));
}

function shouldPollApiFootball(matches) {
  return isInLiveWindow(matches);
}

function apiFootballStatus(short) {
  const s = String(short || "").toUpperCase();
  if (["1H", "2H", "ET", "BT", "P", "LIVE"].includes(s)) return "IN_PLAY";
  if (s === "HT") return "PAUSED";
  if (["FT", "AET", "PEN"].includes(s)) return "FINISHED";
  if (["AWD", "WO"].includes(s)) return "AWARDED";
  if (s === "PST") return "POSTPONED";
  if (["CANC", "ABD", "SUSP", "INT"].includes(s)) return "SUSPENDED";
  return null;
}

function apiFootballDuration(short) {
  const s = String(short || "").toUpperCase();
  if (s === "AET") return "EXTRA_TIME";
  if (s === "PEN") return "PENALTY_SHOOTOUT";
  return null;
}

function fixtureGoalPair(fixture) {
  const goals = fixture?.goals || {};
  return scorePart({ home: goals.home, away: goals.away });
}

function fixtureFulltimePair(fixture) {
  return scorePart(fixture?.score?.fulltime);
}

function findApiFixture(match, fixtures) {
  const home = normalizeName(match.homeTeam?.name);
  const away = normalizeName(match.awayTeam?.name);
  if (!home || !away) return null;
  return fixtures.find((f) => {
    const fHome = normalizeName(f?.teams?.home?.name);
    const fAway = normalizeName(f?.teams?.away?.name);
    return fHome === home && fAway === away && closeKickoff(match.kickoffAt, f?.fixture?.date);
  }) || null;
}

async function fetchApiFootballFixtures(matches) {
  if (!API_FOOTBALL_KEY) {
    console.log("Brak API_FOOTBALL_KEY/API_SPORTS_KEY — live-score z API-Football pominięty.");
    return [];
  }
  if (!shouldPollApiFootball(matches)) {
    console.log("Brak meczu w oknie live — API-Football pominięte dla oszczędzania limitu.");
    return [];
  }
  const now = Date.now();
  const from = ymdUtc(new Date(now - 24 * 60 * 60 * 1000));
  const to = ymdUtc(new Date(now + 24 * 60 * 60 * 1000));
  const url = new URL(API_FOOTBALL_BASE + "/fixtures");
  url.searchParams.set("league", String(WORLD_CUP_LEAGUE_ID));
  url.searchParams.set("season", String(WORLD_CUP_SEASON));
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  url.searchParams.set("timezone", "UTC");

  try {
    const res = await fetch(url, { headers: { "x-apisports-key": API_FOOTBALL_KEY } });
    const text = await res.text();
    if (!res.ok) {
      console.warn(`API-Football live-score pominięty: HTTP ${res.status} ${text.slice(0, 200)}`);
      return [];
    }
    const data = JSON.parse(text);
    if (data.errors && Object.keys(data.errors).length) {
      console.warn("API-Football zwróciło błędy:", JSON.stringify(data.errors).slice(0, 300));
    }
    return Array.isArray(data.response) ? data.response : [];
  } catch (e) {
    console.warn("API-Football live-score pominięty:", e?.message || e);
    return [];
  }
}

function mergeApiFootballLive(matches, fixtures) {
  if (!fixtures.length) return { matches, merged: 0, live: 0 };
  let merged = 0;
  let live = 0;
  const next = matches.map((m) => {
    const f = findApiFixture(m, fixtures);
    if (!f) return m;
    const short = f.fixture?.status?.short || "";
    const mappedStatus = apiFootballStatus(short);
    const livePair = fixtureGoalPair(f);
    const regularPair = fixtureFulltimePair(f);
    const duration = apiFootballDuration(short);
    const patch = {
      apiSportsFixtureId: f.fixture?.id || null,
      apiSportsStatus: short || null,
      liveElapsed: typeof f.fixture?.status?.elapsed === "number" ? f.fixture.status.elapsed : null,
      liveExtra: typeof f.fixture?.status?.extra === "number" ? f.fixture.status.extra : null
    };
    if (mappedStatus) patch.status = mappedStatus;
    if (duration) patch.duration = duration;
    if (typeof livePair.home === "number" && typeof livePair.away === "number") {
      patch.homeScore = livePair.home;
      patch.awayScore = livePair.away;
    }
    if (typeof regularPair.home === "number" && typeof regularPair.away === "number") {
      patch.regularHomeScore = regularPair.home;
      patch.regularAwayScore = regularPair.away;
    }
    if (["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(String(short).toUpperCase())) live++;
    merged++;
    return { ...m, ...patch };
  });
  return { matches: next, merged, live };
}

// =============================================================================
//  ESPN (nieoficjalne, DARMOWE, bez klucza) — główne źródło LIVE dla MŚ 2026.
//  API-Football free nie ma sezonu 2026, a football-data.org free nie podaje
//  wyniku w trakcie meczu. ESPN scoreboard daje status, wynik i minutę na żywo.
// =============================================================================
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

function ymdCompact(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Mapowanie stanu ESPN -> nasz status. "pre" zostawiamy (mecz przed startem).
function espnStatusMap(typeName, state) {
  if (String(typeName || "").toUpperCase() === "STATUS_HALFTIME") return "PAUSED";
  if (state === "in") return "IN_PLAY";
  if (state === "post") return "FINISHED";
  return null;
}

function espnMinute(status) {
  const m = String(status?.displayClock || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

async function fetchEspnEvents(matches) {
  if (!isInEspnWindow(matches)) {
    console.log("Brak meczu w oknie ESPN — ESPN pominięte.");
    return [];
  }
  const now = Date.now();
  const dates = new Set();
  const DAY = 24 * 60 * 60 * 1000;
  for (const m of matches) {
    if (!inWindow(m, ESPN_WINDOW_AFTER_MS, now)) continue;
    const t = Date.parse(m.kickoffAt);
    // ESPN grupuje mecze wg daty US (strefa za UTC), więc mecz nocny UTC (np. 02:00)
    // trafia u nich pod POPRZEDNI dzień. Pytamy więc o dzień meczu I dzień wcześniej.
    dates.add(ymdCompact(new Date(t)));
    dates.add(ymdCompact(new Date(t - DAY)));
  }
  if (!dates.size) dates.add(ymdCompact(new Date(now)));
  const events = [];
  for (const d of dates) {
    try {
      const res = await fetch(`${ESPN_SCOREBOARD}?dates=${d}`);
      if (!res.ok) {
        console.warn(`ESPN ${d}: HTTP ${res.status} — pomijam.`);
        continue;
      }
      const data = await res.json();
      if (Array.isArray(data.events)) events.push(...data.events);
    } catch (e) {
      console.warn("ESPN pominięte:", e?.message || e);
    }
  }
  return events;
}

function findEspnEvent(match, events) {
  const home = normalizeName(match.homeTeam?.name);
  const away = normalizeName(match.awayTeam?.name);
  if (!home || !away) return null;
  return (
    events.find((e) => {
      const cs = e?.competitions?.[0]?.competitors || [];
      const h = cs.find((x) => x.homeAway === "home");
      const a = cs.find((x) => x.homeAway === "away");
      const eh = normalizeName(h?.team?.displayName || h?.team?.name);
      const ea = normalizeName(a?.team?.displayName || a?.team?.name);
      return eh === home && ea === away && closeKickoff(match.kickoffAt, e?.date);
    }) || null
  );
}

// Nakłada live z ESPN na mecze. Zwraca nową tablicę + liczniki.
function mergeEspnLive(matches, events) {
  if (!events.length) return { matches, merged: 0, live: 0 };
  let merged = 0;
  let live = 0;
  const next = matches.map((m) => {
    const e = findEspnEvent(m, events);
    if (!e) return m;
    const comp = e.competitions[0];
    const st = e.status || comp?.status || {};
    const mapped = espnStatusMap(st.type?.name, st.type?.state);
    if (!mapped) return m; // "pre" — bez nadpisywania
    const cs = comp.competitors || [];
    const h = cs.find((x) => x.homeAway === "home");
    const a = cs.find((x) => x.homeAway === "away");
    const hs = h ? parseInt(h.score, 10) : NaN;
    const as = a ? parseInt(a.score, 10) : NaN;
    const patch = { status: mapped, liveElapsed: espnMinute(st) };
    if (Number.isFinite(hs) && Number.isFinite(as)) {
      patch.homeScore = hs;
      patch.awayScore = as;
    }
    if (mapped === "IN_PLAY" || mapped === "PAUSED") live++;
    merged++;
    return { ...m, ...patch };
  });
  return { matches: next, merged, live };
}

const res = await fetch("https://api.football-data.org/v4/competitions/WC/matches", {
  headers: { "X-Auth-Token": TOKEN }
});

if (!res.ok) {
  // Chwilowy problem z API (rate-limit itp.) — NIE psujemy joba (exit 0),
  // zostawiamy ostatni dobry terminarz. Inaczej GitHub slalby maile o bledzie.
  console.warn("Chwilowy blad API football-data.org:", res.status, await res.text());
  console.warn("Pomijam aktualizacje — zostaje ostatnia dobra wersja.");
  process.exit(0);
}

const data = await res.json();
if (!Array.isArray(data.matches)) {
  console.warn("Niespodziewana odpowiedz API (brak pola matches) — pomijam aktualizacje.");
  process.exit(0);
}

let matches = data.matches
  .map((m) => {
    const ft = scorePart(m.score?.fullTime);
    const rt = scorePart(m.score?.regularTime);
    return {
      id: "wc-" + m.id,
      stage: stagePl(m.stage),
      group: m.group ? m.group.replace("GROUP_", "") : null,
      matchday: typeof m.matchday === "number" ? m.matchday : null,
      kickoffAt: m.utcDate,
      homeTeam: {
        id: m.homeTeam?.id ? "t" + m.homeTeam.id : "tbd-" + m.id + "-h",
        name: plName(m.homeTeam?.name),
        crest: m.homeTeam?.crest || null
      },
      awayTeam: {
        id: m.awayTeam?.id ? "t" + m.awayTeam.id : "tbd-" + m.id + "-a",
        name: plName(m.awayTeam?.name),
        crest: m.awayTeam?.crest || null
      },
      status: m.status,
      // REGULAR / EXTRA_TIME / PENALTY_SHOOTOUT — do typów liczy się tylko czas
      // regulaminowy (REGULAR). Przy dogrywce auto-wynik z API zawiera dogrywkę.
      duration: m.score?.duration || "REGULAR",
      // Faktyczny zwycięzca (też po dogrywce/karnych) — do "kto awansuje" i mistrza.
      winner: m.score?.winner || null,
      // Wynik dopisywany automatycznie, gdy mecz ma rezultat:
      // fullTime jest też wynikiem bieżącym w trakcie statusu IN_PLAY/PAUSED.
      homeScore: ft.home,
      awayScore: ft.away,
      // W pucharach do typów liczymy 90', więc zapisujemy regularTime, jeśli API poda.
      regularHomeScore: rt.home,
      regularAwayScore: rt.away,
      lastUpdated: m.lastUpdated || null
    };
  })
  .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));

// BEZPIECZNIK: nie nadpisuj terminarza, jeśli API zwróciło podejrzanie mało meczów
// (np. {matches: []} przy rate-limicie/chwilowym błędzie z kodem 200). Inaczej
// cały terminarz i typy "znikają" do następnego przebiegu. MŚ = 104 mecze.
if (matches.length < 64) {
  // Za malo meczow (pewnie chwilowy blad API) — pomijamy zapis, ale konczymy
  // sukcesem (exit 0), zeby GitHub nie wysylal maili o nieudanym przebiegu.
  console.warn(
    `API zwrocilo tylko ${matches.length} meczow — pomijam zapis (zostaje ostatnia dobra wersja).`
  );
  process.exit(0);
}

// Live: ESPN (darmowe, główne źródło) + API-Football (tylko jeśli ustawiony klucz
// płatnego planu). ESPN nakłada się na końcu, więc ma pierwszeństwo.
const apiFootballFixtures = await fetchApiFootballFixtures(matches);
const apiMerge = mergeApiFootballLive(matches, apiFootballFixtures);
const espnEvents = await fetchEspnEvents(matches);
const espnMerge = mergeEspnLive(apiMerge.matches, espnEvents);
const liveMatches = espnMerge.matches; // pełna nakładka live (z minutą) -> Firestore

// STICKY FINALS: nie wolno cofnąć zakończonego meczu do TIMED. Football-data.org
// free nie podaje wyniku, a ESPN po oknie milknie — bez tego po meczu ranking się
// zerował. Czytamy poprzedni matches.json i zachowujemy wynik końcowy, jeśli nowy
// build go nie ma (a stary miał FINISHED/AWARDED z liczbowym wynikiem).
let prevById = {};
try {
  const prev = JSON.parse(await readFile("data/matches.json", "utf8"));
  for (const m of prev) prevById[m.id] = m;
} catch (_) {}
const FINAL_STATUSES = new Set(["FINISHED", "AWARDED"]);

// Do PLIKU bez minuty (liveElapsed) — inaczej matches.json zmieniałby się co minutę
// i robot commitowałby w kółko. Bez minuty plik zmienia się tylko przy realnej
// zmianie wyniku/statusu (kilka commitów na mecz). Live "co sekundę" idzie Firestore.
const matchesForFile = liveMatches.map(({ liveElapsed, liveExtra, ...rest }) => {
  if (!FINAL_STATUSES.has(rest.status)) {
    const p = prevById[rest.id];
    if (p && FINAL_STATUSES.has(p.status) && typeof p.homeScore === "number") {
      return {
        ...rest,
        status: p.status,
        homeScore: p.homeScore,
        awayScore: p.awayScore,
        regularHomeScore: p.regularHomeScore ?? rest.regularHomeScore,
        regularAwayScore: p.regularAwayScore ?? rest.regularAwayScore,
        duration: p.duration || rest.duration,
        winner: p.winner ?? rest.winner
      };
    }
  }
  return rest;
});
await writeFile("data/matches.json", JSON.stringify(matchesForFile, null, 2) + "\n", "utf8");
matches = matchesForFile;

// Flaga dla workflow: gdy trwa okno meczu, pętla w GitHub Actions odpytuje co
// kilka minut (cron */5 bywa dławiony przez GitHub do co 2-3 h — za rzadko na live).
try {
  if (isInLiveWindow(matches)) await writeFile("live-window.flag", "1");
  else await rm("live-window.flag", { force: true });
} catch (_) {}

// Live-wynik -> Firestore (live/state). Frontend nasłuchuje tego dokumentu przez
// onSnapshot, więc gol pojawia się u graczy NATYCHMIAST (push), bez czekania na
// commit pliku i przebudowę GitHub Pages. Piszemy tylko mecze w oknie live.
await writeLiveToFirestore(liveMatches);

async function writeLiveToFirestore(allMatches) {
  const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!SA) {
    console.log("Brak FIREBASE_SERVICE_ACCOUNT — live do Firestore pominięty.");
    return;
  }
  const now = Date.now();
  const overlay = {};
  for (const m of allMatches) {
    const t = Date.parse(m.kickoffAt);
    if (!Number.isFinite(t)) continue;
    if (now < t - LIVE_WINDOW_BEFORE_MS || now > t + LIVE_WINDOW_AFTER_MS) continue;
    overlay[m.id] = {
      status: m.status,
      homeName: m.homeTeam?.name ?? null,
      awayName: m.awayTeam?.name ?? null,
      homeScore: m.homeScore ?? null,
      awayScore: m.awayScore ?? null,
      regularHomeScore: m.regularHomeScore ?? null,
      regularAwayScore: m.regularAwayScore ?? null,
      duration: m.duration || "REGULAR",
      winner: m.winner ?? null,
      liveElapsed: typeof m.liveElapsed === "number" ? m.liveElapsed : null
    };
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
    }
    await admin.firestore().doc("live/state").set({
      matches: overlay,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`Live -> Firestore: ${Object.keys(overlay).length} meczów w oknie.`);
  } catch (e) {
    console.warn("Zapis live do Firestore pominięty:", e?.message || e);
  }
}

const finished = matches.filter((m) => m.status === "FINISHED" || m.status === "AWARDED").length;
const live = matches.filter((m) => m.status === "IN_PLAY" || m.status === "PAUSED").length;
console.log(
  `Zapisano ${matches.length} meczów (zakończone: ${finished}, live: ${live}, ` +
    `ESPN: ${espnMerge.merged} dopas./${espnMerge.live} live, API-Football: ${apiMerge.merged} dopas.).`
);

// firebase-admin trzyma otwarte połączenie (gRPC), które potrafi blokować
// wyjście procesu — bez tego krok w GitHub Actions wisiałby do timeoutu, a pętla
// na żywo by się zatrzymała. Wszystkie zapisy są już zawaitowane, więc kończymy.
process.exit(0);
