// =============================================================================
//  ROBOT: wysyła powiadomienia push (Web Push / VAPID) o nowym liderze rankingu
//  i o zakończonych meczach. Uruchamiany przez GitHub Actions po aktualizacji
//  wyników. Wysyła nawet wtedy, gdy aplikacja jest zamknięta.
//
//  Wymaga sekretów w repo:
//   - FIREBASE_SERVICE_ACCOUNT  (zawartość pliku klucza konta serwisowego)
//   - VAPID_PRIVATE_KEY         (prywatny klucz VAPID)
//  Jeśli ich nie ma — skrypt po cichu kończy (reszta robota działa dalej).
// =============================================================================

import admin from "firebase-admin";
import webpush from "web-push";
import { readFileSync } from "node:fs";

// Wysyłka powiadomień to dodatek — jej błąd NIE może wywalać całego joba
// (inaczej GitHub Actions wysyła maile o nieudanym przebiegu). Każdy nieobsłużony
// błąd logujemy i kończymy sukcesem.
process.on("unhandledRejection", (e) => {
  console.error("push (unhandledRejection):", e);
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  console.error("push (uncaughtException):", e);
  process.exit(0);
});

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC =
  "BFKlY3QsPdbL1yOLIz_ZJCM1NasX7k1N1NgqarkIa2-q3q08K7RQQtoMDWv6AKgyEKW5fR7ejks7COC-WfDRY5w";

const missingSecrets = [];
if (!SA) missingSecrets.push("FIREBASE_SERVICE_ACCOUNT");
if (!VAPID_PRIVATE) missingSecrets.push("VAPID_PRIVATE_KEY");
if (missingSecrets.length) {
  console.log(`Brak sekretów push: ${missingSecrets.join(", ")} — pomijam wysyłkę.`);
  process.exit(0);
}

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SA)) });
const db = admin.firestore();
webpush.setVapidDetails("mailto:mateuszjoe@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

const settings = JSON.parse(readFileSync("data/settings.json", "utf8"));
const matches = JSON.parse(readFileSync("data/matches.json", "utf8"));

// --- Dane z bazy --------------------------------------------------------------
const predictions = {};
(await db.collection("predictions").get()).forEach((d) => (predictions[d.id] = d.data()));

const subs = [];
(await db.collection("pushSubs").get()).forEach((d) => subs.push({ uid: d.id, ...d.data() }));

const chatMessages = [];
(await db.collection("chat").orderBy("createdAt", "desc").limit(20).get()).forEach((d) =>
  chatMessages.push({ id: d.id, ...d.data() })
);
chatMessages.reverse(); // najstarsze z ostatniej paczki najpierw

const adminDoc = await db.doc("admin/state").get();
const adminState = adminDoc.exists ? adminDoc.data() : {};
const overrideResults = adminState.results || {};
const adminChampion = adminState.championTeamId || null;

const stateRef = db.doc("push/state");
const stateDoc = await stateRef.get();

function timestampMs(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

// --- Punktacja (zgodna z aplikacją) ------------------------------------------
const FINAL_MATCH_STATUSES = new Set(["FINISHED", "AWARDED"]);
function scorePair(h, a) {
  if (typeof h === "number" && typeof a === "number") return { h, a };
  return null;
}
const LIVE_MATCH_STATUSES = new Set(["IN_PLAY", "PAUSED"]);
function getResult(m) {
  const o = overrideResults[m.id];
  if (o && typeof o.h === "number" && typeof o.a === "number") return o;
  if (!FINAL_MATCH_STATUSES.has(m.status)) return null;
  if (m.duration && m.duration !== "REGULAR")
    return scorePair(m.regularHomeScore, m.regularAwayScore);
  return scorePair(m.homeScore, m.awayScore);
}
// Wynik do RANKINGU = ten sam co w apce: punkty liczą się też z meczu W TRAKCIE
// (bieżący wynik). Nie ma osobnej kategorii "finały" — to po prostu kolejne punkty.
function getRankingResult(m) {
  const final = getResult(m);
  if (final) return final;
  if (!LIVE_MATCH_STATUSES.has(m.status)) return null;
  if (m.duration && m.duration !== "REGULAR")
    return scorePair(m.regularHomeScore, m.regularAwayScore) || scorePair(m.homeScore, m.awayScore);
  return scorePair(m.homeScore, m.awayScore);
}
const outcome = (h, a) => (h > a ? "home" : h < a ? "away" : "draw");
function scoreMatch(pred, r) {
  if (!pred || !r || pred.h == null || pred.a == null) return { points: 0, exact: false, correct: false };
  if (pred.h === r.h && pred.a === r.a)
    return { points: settings.points.exactScore, exact: true, correct: true };
  const c = outcome(pred.h, pred.a) === outcome(r.h, r.a);
  return { points: c ? settings.points.correctResult : 0, exact: false, correct: c };
}
function championTeamId() {
  if (adminChampion) return adminChampion;
  const fin = matches.find((m) => m.stage === "finał");
  if (!fin) return null;
  if (fin.winner === "HOME_TEAM") return fin.homeTeam.id;
  if (fin.winner === "AWAY_TEAM") return fin.awayTeam.id;
  const r = getResult(fin);
  if (!r || r.h === r.a) return null;
  return r.h > r.a ? fin.homeTeam.id : fin.awayTeam.id;
}
const champId = championTeamId();

function leaderboard() {
  const rows = Object.entries(predictions).map(([uid, p]) => {
    let exact = 0;
    let outcomeOnly = 0;
    for (const m of matches) {
      const s = scoreMatch(p.matches?.[m.id], getRankingResult(m));
      if (s.exact) exact++;
      else if (s.correct) outcomeOnly++;
    }
    const champPts = p.champion && champId && p.champion === champId ? settings.points.tournamentWinner : 0;
    const total = exact * settings.points.exactScore + outcomeOnly * settings.points.correctResult + champPts;
    return { uid, name: p.name || "Gracz", exact, outcomeOnly, total };
  });
  rows.sort(
    (l, r) =>
      r.total - l.total ||
      r.exact - l.exact ||
      r.outcomeOnly - l.outcomeOnly ||
      l.name.localeCompare(r.name, "pl")
  );
  return rows;
}

const board = leaderboard();
const leader = board[0]?.uid || null;

// --- Fazy turnieju (ogłoszenia przed startem) --------------------------------
const NOW = Date.now();
const PHASE_LEAD_MS = 4 * 60 * 60 * 1000; // ogłaszamy ~4h przed pierwszym meczem fazy
const PHASE_GRACE_MS = 2 * 60 * 60 * 1000; // jeśli okno minęło o >2h — tylko oznacz, nie wysyłaj

function plTime(iso) {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone: "Europe/Warsaw", hour: "2-digit", minute: "2-digit"
  }).format(new Date(iso));
}
function plDate(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(d);
}
function plHour(d) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Warsaw", hour: "2-digit", hour12: false }).format(d));
}
function realTeam(t) {
  return Boolean(t && t.name && t.name !== "TBD" && !String(t.id || "").startsWith("tbd-"));
}
function earliest(ms) {
  return ms.length ? ms.reduce((a, b) => (a.kickoffAt <= b.kickoffAt ? a : b)) : null;
}

const KO_STAGES = ["1/16 finału", "1/8 finału", "ćwierćfinał", "półfinał", "mecz o 3. miejsce", "finał"];
const KO_TITLES = {
  "1/16 finału": "🏆 Faza pucharowa — 1/16 finału!",
  "1/8 finału": "🏆 1/8 finału!",
  "ćwierćfinał": "🏆 Ćwierćfinały!",
  "półfinał": "🏆 Półfinały!",
  "mecz o 3. miejsce": "🥉 Mecz o 3. miejsce",
  "finał": "🏆 FINAŁ!"
};

// Pary z nazwami drużyn (tylko realne, znane drużyny) — nic nie zgadujemy.
function knockoutPairsBody(stageMatches, stage) {
  const pairs = stageMatches
    .filter((m) => realTeam(m.homeTeam) && realTeam(m.awayTeam))
    .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
    .map((m) => `${m.homeTeam.name} – ${m.awayTeam.name}`);
  const list = pairs.length ? pairs.slice(0, 4).join(", ") + (pairs.length > 4 ? " i inne" : "") + ". " : "";
  const tail = stage === "finał" ? "Gra się o złoto! ⚽" : "W pucharach przegrany odpada — typuj!";
  return list + tail;
}

function buildPhases() {
  const out = [];
  const first = earliest(matches);
  if (first) {
    out.push({
      key: "start",
      first,
      payload: () => ({
        title: "⚽ Zaczyna się Mundial!",
        body: `Pierwszy gwizdek o ${plTime(first.kickoffAt)}: ${first.homeTeam.name} – ${first.awayTeam.name}. Wbijaj i typuj!`
      })
    });
  }
  for (const md of [2, 3]) {
    const f = earliest(matches.filter((m) => m.stage === "group" && m.matchday === md));
    if (!f) continue;
    out.push({
      key: "md" + md,
      first: f,
      payload: () =>
        md === 3
          ? { title: "📅 Ostatnia kolejka w grupach!", body: "Dziś rozstrzyga się awans z grup — wytypuj dzisiejsze mecze, zanim padnie pierwszy gwizdek." }
          : { title: "📅 Rusza 2. kolejka grupowa", body: "Druga seria meczów w grupach. Uzupełnij typy przed startem!" }
    });
  }
  for (const stage of KO_STAGES) {
    const stageMatches = matches.filter((m) => m.stage === stage);
    const f = earliest(stageMatches);
    if (!f) continue;
    out.push({
      key: "stage:" + stage,
      first: f,
      payload: () => ({ title: KO_TITLES[stage] || "🏆 " + stage, body: knockoutPairsBody(stageMatches, stage) })
    });
  }
  return out;
}
const phases = buildPhases();

// --- Pierwszy przebieg: ustal punkt odniesienia, nie spamuj -------------------
if (!stateDoc.exists) {
  const finished = matches.filter((m) => getResult(m)).map((m) => m.id);
  const lastChatMs = chatMessages.reduce((max, msg) => Math.max(max, timestampMs(msg.createdAt)), 0);
  // Fazy, których okno już się otworzyło — uznaj za ogłoszone, by nie zalać przy starcie.
  const alreadyOpen = phases
    .filter((ph) => NOW >= Date.parse(ph.first.kickoffAt) - PHASE_LEAD_MS)
    .map((ph) => ph.key);
  await stateRef.set({ notified: finished, lastLeader: leader, lastChatMs, announcedPhases: alreadyOpen, typeReminders: {} });
  console.log("Pierwszy przebieg — zapamiętano stan, bez wysyłki.");
  process.exit(0);
}

const pstate = stateDoc.data();
const notified = new Set(pstate.notified || []);
let lastLeader = pstate.lastLeader || null;
const hasChatState = typeof pstate.lastChatMs === "number";
let lastChatMs = hasChatState
  ? pstate.lastChatMs
  : chatMessages.reduce((max, msg) => Math.max(max, timestampMs(msg.createdAt)), 0);

// --- Wysyłka ------------------------------------------------------------------
async function sendTo(entry, payload) {
  try {
    await webpush.sendNotification(entry.sub, JSON.stringify(payload));
    return { ok: true, uid: entry.uid };
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db.doc("pushSubs/" + entry.uid).delete(); // subskrypcja wygasła
    } else {
      console.warn("push err", entry.uid, e.statusCode || e.message);
    }
    return { ok: false, uid: entry.uid, error: e.statusCode || e.message };
  }
}

const jobs = [];

// Czat: powiadomienia o nowych wiadomościach wysyła teraz natychmiastowo Cloud
// Function onChatMessage (functions/index.js) — robot ich NIE dubluje. Tu tylko
// przesuwamy znacznik, żeby stan był spójny.
if (hasChatState) {
  for (const msg of chatMessages) {
    lastChatMs = Math.max(lastChatMs, timestampMs(msg.createdAt));
  }
}

// Zakończone mecze (nowe)
for (const m of matches) {
  const r = getResult(m);
  if (!r || notified.has(m.id)) continue;
  notified.add(m.id);
  const title = `⚽ ${m.homeTeam.name} ${r.h}:${r.a} ${m.awayTeam.name}`;
  for (const entry of subs) {
    const pred = predictions[entry.uid]?.matches?.[m.id];
    let body;
    if (!pred) {
      body = `Wynik ${r.h}:${r.a}, a Ty nawet nie obstawiłeś. Wstyd, mordo.`;
    } else {
      const s = scoreMatch(pred, r);
      body = s.exact
        ? `JA PIERDOLĘ! Dokładny wynik ${r.h}:${r.a} trafiony! +${s.points} pkt, ty jasnowidzu!`
        : s.correct
        ? `Rezultat trafiony, +${s.points} pkt do kieszeni. Mogło być lepiej, ale jest.`
        : `Chuja trafiłeś i chuja dostałeś. 0 pkt. Następnym razem rusz głową.`;
    }
    jobs.push(sendTo(entry, { title, body }));
  }
}

// Nowy lider rankingu
if (leader && leader !== lastLeader && board[0].total > 0) {
  lastLeader = leader;
  for (const entry of subs) {
    const me = entry.uid === leader;
    jobs.push(
      sendTo(entry, {
        title: "👑 Nowy lider rankingu!",
        body: me
          ? "Jesteś nowym liderem! Tylko tego nie spierdol."
          : `${board[0].name} wskakuje na 1. miejsce i depcze wam po pysku. Ktoś to ogarnie?`
      })
    );
  }
}

// --- Ogłoszenia faz turnieju (do wszystkich subskrybentów) -------------------
const announced = new Set(pstate.announcedPhases || []);
for (const ph of phases) {
  if (announced.has(ph.key)) continue;
  const start = Date.parse(ph.first.kickoffAt);
  if (NOW < start - PHASE_LEAD_MS) continue; // jeszcze za wcześnie
  announced.add(ph.key); // oznacz raz (niezależnie od wysyłki)
  if (NOW > start + PHASE_GRACE_MS) continue; // okno minęło (np. robot spał) — nie wysyłaj
  const payload = ph.payload();
  for (const entry of subs) {
    jobs.push(sendTo(entry, { ...payload, tag: "phase-" + ph.key, url: "./#mine" }));
  }
}

// --- Poranne przypomnienie o nietypowanych meczach na dziś (per gracz) -------
const today = plDate(new Date(NOW));
const typeReminders = { ...(pstate.typeReminders || {}) };
if (plHour(new Date(NOW)) >= 8) {
  const todaysMatches = matches.filter(
    (m) =>
      realTeam(m.homeTeam) &&
      realTeam(m.awayTeam) &&
      plDate(new Date(m.kickoffAt)) === today &&
      Date.parse(m.kickoffAt) > NOW // jeszcze się nie zaczął — można typować
  );
  if (todaysMatches.length) {
    for (const entry of subs) {
      const p = predictions[entry.uid];
      if (!p || p.approved === false) continue; // poczekalnia nie typuje
      if (typeReminders[entry.uid] === today) continue; // już dziś przypomniano
      const untyped = todaysMatches.filter((m) => {
        const pk = p.matches?.[m.id];
        return !(pk && pk.h != null && pk.a != null);
      });
      if (!untyped.length) continue;
      typeReminders[entry.uid] = today;
      jobs.push(
        sendTo(entry, {
          title: "⏰ Wytypuj dzisiejsze mecze!",
          body: `Masz ${untyped.length} ${untyped.length === 1 ? "nieobstawiony mecz" : "nieobstawionych meczów"} na dziś. Zdążysz przed gwizdkiem — wbijaj!`,
          tag: "type-reminder",
          url: "./#mine"
        })
      );
    }
  }
}

const settled = await Promise.allSettled(jobs);
const sent = settled.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
const failed = settled.length - sent;
await stateRef.set(
  { notified: [...notified], lastLeader, lastChatMs, announcedPhases: [...announced], typeReminders },
  { merge: true }
);
console.log(`Wysłano ${sent}/${jobs.length} powiadomień (błędy: ${failed}, subskrypcji: ${subs.length}).`);
