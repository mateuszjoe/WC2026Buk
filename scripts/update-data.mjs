// =============================================================================
//  ROBOT: pobiera terminarz i wyniki MŚ 2026 z football-data.org i zapisuje je
//  do data/matches.json. Uruchamiany przez GitHub Actions (co 30 min + ręcznie).
//
//  Token API czytany jest z sekretu FOOTBALL_DATA_TOKEN (ustawiany w repo na
//  GitHubie). NIE wpisuj tokenu do kodu.
// =============================================================================

import { writeFile } from "node:fs/promises";

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

const matches = data.matches
  .map((m) => {
    const ft = m.score?.fullTime || {};
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
      homeScore: typeof ft.home === "number" ? ft.home : null,
      awayScore: typeof ft.away === "number" ? ft.away : null
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

await writeFile("data/matches.json", JSON.stringify(matches, null, 2) + "\n", "utf8");

const finished = matches.filter((m) => m.homeScore !== null).length;
console.log(`Zapisano ${matches.length} meczów (z wynikiem: ${finished}).`);
