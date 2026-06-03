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

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_PUBLIC =
  "BAQl5Gb6pj34iL4XK6NAtjsmNDhYJB7gkOLB5KFE93taOpMLVtFMlhShRBqQjjNekXn5eRC3TT9ysggxZyVXgJM";

if (!SA || !VAPID_PRIVATE) {
  console.log("Brak sekretów push (FIREBASE_SERVICE_ACCOUNT / VAPID_PRIVATE_KEY) — pomijam wysyłkę.");
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

const adminDoc = await db.doc("admin/state").get();
const adminState = adminDoc.exists ? adminDoc.data() : {};
const overrideResults = adminState.results || {};
const adminChampion = adminState.championTeamId || null;

const stateRef = db.doc("push/state");
const stateDoc = await stateRef.get();

// --- Punktacja (zgodna z aplikacją) ------------------------------------------
function getResult(m) {
  const o = overrideResults[m.id];
  if (o && typeof o.h === "number" && typeof o.a === "number") return o;
  if (typeof m.homeScore === "number" && typeof m.awayScore === "number")
    return { h: m.homeScore, a: m.awayScore };
  return null;
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
      const s = scoreMatch(p.matches?.[m.id], getResult(m));
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

// --- Pierwszy przebieg: ustal punkt odniesienia, nie spamuj -------------------
if (!stateDoc.exists) {
  const finished = matches.filter((m) => getResult(m)).map((m) => m.id);
  await stateRef.set({ notified: finished, lastLeader: leader });
  console.log("Pierwszy przebieg — zapamiętano stan, bez wysyłki.");
  process.exit(0);
}

const pstate = stateDoc.data();
const notified = new Set(pstate.notified || []);
let lastLeader = pstate.lastLeader || null;

// --- Wysyłka ------------------------------------------------------------------
async function sendTo(entry, payload) {
  try {
    await webpush.sendNotification(entry.sub, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      await db.doc("pushSubs/" + entry.uid).delete(); // subskrypcja wygasła
    } else {
      console.warn("push err", entry.uid, e.statusCode || e.message);
    }
  }
}

const jobs = [];

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

await Promise.allSettled(jobs);
await stateRef.set({ notified: [...notified], lastLeader }, { merge: true });
console.log(`Wysłano ${jobs.length} powiadomień (subskrypcji: ${subs.length}).`);
