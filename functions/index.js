// =============================================================================
//  FIREBASE CLOUD FUNCTIONS — natychmiastowy web push (zdarzeniowy, ~2 s).
//  Nie czeka na robota (GitHub Actions): reaguje wprost na zapis w Firestore.
//   - onChatMessage: nowa wiadomość na czacie -> push do wszystkich (poza autorem)
//   - onLiveScore:   gol (wzrost sumy bramek w live/state) -> push "GOL!"
//
//  Wdrożenie wymaga planu Blaze i sekretu VAPID_PRIVATE_KEY (instrukcja w README).
//  Finalne wyniki / lider / przypomnienia nadal wysyła robot (scripts/send-push.mjs).
// =============================================================================

const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const webpush = require("web-push");

admin.initializeApp();
const db = admin.firestore();

// Klucz publiczny VAPID — ten sam co w app.js i send-push.mjs. Prywatny trzymamy
// jako sekret Functions (firebase functions:secrets:set VAPID_PRIVATE_KEY).
const VAPID_PUBLIC =
  "BFKlY3QsPdbL1yOLIz_ZJCM1NasX7k1N1NgqarkIa2-q3q08K7RQQtoMDWv6AKgyEKW5fR7ejks7COC-WfDRY5w";
const VAPID_PRIVATE = defineSecret("VAPID_PRIVATE_KEY");

setGlobalOptions({ maxInstances: 5 });

// Wyślij payload do wszystkich subskrypcji push (opcjonalnie pomijając jeden uid).
async function sendToAll(payload, excludeUid) {
  webpush.setVapidDetails("mailto:mateuszjoe@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE.value());
  const snap = await db.collection("pushSubs").get();
  const jobs = [];
  snap.forEach((d) => {
    if (excludeUid && d.id === excludeUid) return;
    const sub = d.data().sub;
    if (!sub) return;
    jobs.push(
      webpush.sendNotification(sub, JSON.stringify(payload)).catch(async (e) => {
        // Subskrypcja wygasła — sprzątamy, żeby nie próbować w kółko.
        if (e.statusCode === 404 || e.statusCode === 410) {
          await db.doc("pushSubs/" + d.id).delete().catch(() => {});
        }
      })
    );
  });
  await Promise.allSettled(jobs);
}

const num = (x) => (typeof x === "number" ? x : 0);

// Nowa wiadomość na czacie -> natychmiastowy push (poza autorem).
exports.onChatMessage = onDocumentCreated(
  { document: "chat/{msgId}", secrets: [VAPID_PRIVATE] },
  async (event) => {
    const msg = event.data && event.data.data();
    if (!msg) return;
    const name = msg.name || "Ktoś";
    const text =
      msg.text && msg.text.trim()
        ? msg.text.slice(0, 120)
        : msg.image
        ? "📷 Zdjęcie"
        : "Nowa wiadomość";
    await sendToAll(
      { title: `💬 ${name}`, body: text, tag: "chat-new", url: "./#chat" },
      msg.uid
    );
  }
);

// Zmiana wyniku na żywo (live/state) -> push "GOL!" gdy suma bramek wzrosła.
exports.onLiveScore = onDocumentWritten(
  { document: "live/state", secrets: [VAPID_PRIVATE] },
  async (event) => {
    const before = (event.data?.before?.data() || {}).matches || {};
    const after = (event.data?.after?.data() || {}).matches || {};
    const LIVE = new Set(["IN_PLAY", "PAUSED"]);
    for (const id of Object.keys(after)) {
      const a = after[id];
      const b = before[id];
      if (!b) continue; // mecz dopiero wszedł do okna — nie ogłaszamy zastanego wyniku
      if (!LIVE.has(a.status)) continue; // gole liczymy tylko w trakcie gry
      const aTotal = num(a.homeScore) + num(a.awayScore);
      const bTotal = num(b.homeScore) + num(b.awayScore);
      if (aTotal <= bTotal) continue; // brak nowej bramki
      const h = a.homeName || "Gospodarze";
      const aw = a.awayName || "Goście";
      await sendToAll({
        title: "⚽ GOL!",
        body: `${h} ${a.homeScore}:${a.awayScore} ${aw}${a.liveElapsed ? ` (${a.liveElapsed}')` : ""}`,
        tag: `goal-${id}-${a.homeScore}-${a.awayScore}`,
        url: "./#matches"
      });
    }
  }
);

// =============================================================================
//  liveScorePoll — NIEZAWODNY live (Cloud Scheduler co 1 min, nie GitHub cron).
//  Pobiera terminarz (raw matches.json), dociąga ESPN dla meczów w oknie i pisze
//  live/state. Dzięki temu ranking live działa nawet gdy robot GitHub Actions śpi.
//  Zapis live/state automatycznie odpala onLiveScore (push o golu).
// =============================================================================
const SCHEDULE_URL =
  "https://raw.githubusercontent.com/mateuszjoe/WC2026Buk/main/data/matches.json";
const ESPN_SCOREBOARD =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const LIVE_BEFORE_MS = 15 * 60 * 1000;
const LIVE_KEEP_MS = 6 * 60 * 60 * 1000; // trzymaj mecz w nakładce do 6 h (też po końcu)
const DAY_MS = 24 * 60 * 60 * 1000;

// Mapa nazw EN->PL (z update-data.mjs) — żeby dopasować ESPN (EN) do pliku (PL).
const PL_NAMES = {
  Poland: "Polska", Mexico: "Meksyk", Canada: "Kanada", "United States": "USA",
  Morocco: "Maroko", Japan: "Japonia", Argentina: "Argentyna",
  "Korea Republic": "Korea Płd.", "South Korea": "Korea Płd.", France: "Francja",
  Croatia: "Chorwacja", Brazil: "Brazylia", Netherlands: "Holandia",
  England: "Anglia", Senegal: "Senegal", Spain: "Hiszpania", Portugal: "Portugalia",
  Germany: "Niemcy", Italy: "Włochy", Belgium: "Belgia", Switzerland: "Szwajcaria",
  Denmark: "Dania", Sweden: "Szwecja", Norway: "Norwegia", Austria: "Austria",
  Serbia: "Serbia", Ukraine: "Ukraina", Wales: "Walia", Scotland: "Szkocja",
  "Czech Republic": "Czechy", Czechia: "Czechy", Turkey: "Turcja", "Türkiye": "Turcja",
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
  "New Caledonia": "Nowa Kaledonia"
};
const norm = (n) =>
  (PL_NAMES[n] || n || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
function espnStatusMap(name, state) {
  if (String(name || "").toUpperCase() === "STATUS_HALFTIME") return "PAUSED";
  if (state === "in") return "IN_PLAY";
  if (state === "post") return "FINISHED";
  return null;
}
function espnMinute(st) {
  const m = String(st?.displayClock || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}
function closeKick(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!isFinite(a) || !isFinite(b)) return false;
  return Math.abs(a - b) <= 3 * 60 * 60 * 1000;
}

exports.liveScorePoll = onSchedule(
  { schedule: "every 1 minutes", region: "europe-west1", timeoutSeconds: 60, memory: "256MiB" },
  async () => {
    const now = Date.now();
    let schedule;
    try {
      const r = await fetch(`${SCHEDULE_URL}?ts=${now}`);
      schedule = await r.json();
    } catch (e) {
      console.warn("liveScorePoll: nie pobrano terminarza:", e.message);
      return;
    }
    const inWin = schedule.filter((m) => {
      const t = Date.parse(m.kickoffAt);
      return isFinite(t) && now >= t - LIVE_BEFORE_MS && now <= t + LIVE_KEEP_MS;
    });
    const ref = db.doc("live/state");
    if (!inWin.length) {
      const cur = (await ref.get()).data();
      if (cur && cur.matches && Object.keys(cur.matches).length) {
        await ref.set({ matches: {}, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      return;
    }
    const dates = new Set();
    for (const m of inWin) {
      const t = Date.parse(m.kickoffAt);
      dates.add(ymd(new Date(t)));
      dates.add(ymd(new Date(t - DAY_MS))); // ESPN grupuje wg daty US (za UTC)
    }
    const events = [];
    for (const d of dates) {
      try {
        const r = await fetch(`${ESPN_SCOREBOARD}?dates=${d}`);
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.events)) events.push(...j.events);
        }
      } catch (_) {}
    }
    const overlay = {};
    for (const m of inWin) {
      const home = norm(m.homeTeam?.name), away = norm(m.awayTeam?.name);
      const e = events.find((ev) => {
        const cs = ev?.competitions?.[0]?.competitors || [];
        const h = cs.find((x) => x.homeAway === "home");
        const a = cs.find((x) => x.homeAway === "away");
        return norm(h?.team?.displayName) === home && norm(a?.team?.displayName) === away &&
          closeKick(m.kickoffAt, ev?.date);
      });
      if (!e) continue;
      const comp = e.competitions[0];
      const st = e.status || comp?.status || {};
      const mapped = espnStatusMap(st.type?.name, st.type?.state);
      if (!mapped) continue; // "pre" — przed startem
      const cs = comp.competitors || [];
      const h = cs.find((x) => x.homeAway === "home");
      const a = cs.find((x) => x.homeAway === "away");
      const hs = h ? parseInt(h.score, 10) : NaN;
      const as = a ? parseInt(a.score, 10) : NaN;
      overlay[m.id] = {
        status: mapped,
        homeName: m.homeTeam?.name ?? null,
        awayName: m.awayTeam?.name ?? null,
        homeScore: Number.isFinite(hs) ? hs : null,
        awayScore: Number.isFinite(as) ? as : null,
        regularHomeScore: null,
        regularAwayScore: null,
        duration: m.duration || "REGULAR",
        winner: null,
        liveElapsed: espnMinute(st)
      };
    }
    await ref.set({ matches: overlay, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`liveScorePoll: ${Object.keys(overlay).length}/${inWin.length} meczów w live/state.`);
  }
);
