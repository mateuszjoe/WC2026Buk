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
