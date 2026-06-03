// =============================================================================
//  ROBOT: pobiera terminarz i wyniki MŚ 2026 z football-data.org i zapisuje je
//  do data/matches.json. Uruchamiany przez GitHub Actions (co 30 min + ręcznie).
//
//  Token API czytany jest z sekretu FOOTBALL_DATA_TOKEN (ustawiany w repo na
//  GitHubie). NIE wpisuj tokenu do kodu.
// =============================================================================

import { writeFile } from "node:fs/promises";

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
  Algeria: "Algieria", Tunisia: "Tunezja", "South Africa": "RPA", "Cape Verde": "Republika Zielonego Przylądka",
  Australia: "Australia", "New Zealand": "Nowa Zelandia", "Saudi Arabia": "Arabia Saudyjska",
  Iran: "Iran", "IR Iran": "Iran", Qatar: "Katar", Iraq: "Irak", Jordan: "Jordania",
  "United Arab Emirates": "ZEA", Uzbekistan: "Uzbekistan"
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
  console.error("Błąd API football-data.org:", res.status, await res.text());
  process.exit(1);
}

const data = await res.json();
if (!Array.isArray(data.matches)) {
  console.error("Niespodziewana odpowiedź API (brak pola matches).");
  process.exit(1);
}

const matches = data.matches
  .map((m) => {
    const ft = m.score?.fullTime || {};
    return {
      id: "wc-" + m.id,
      stage: stagePl(m.stage),
      group: m.group ? m.group.replace("GROUP_", "") : null,
      kickoffAt: m.utcDate,
      homeTeam: {
        id: m.homeTeam?.id ? "t" + m.homeTeam.id : "tbd-" + m.id + "-h",
        name: plName(m.homeTeam?.name)
      },
      awayTeam: {
        id: m.awayTeam?.id ? "t" + m.awayTeam.id : "tbd-" + m.id + "-a",
        name: plName(m.awayTeam?.name)
      },
      status: m.status,
      // Wynik dopisywany automatycznie, gdy mecz ma rezultat:
      homeScore: typeof ft.home === "number" ? ft.home : null,
      awayScore: typeof ft.away === "number" ? ft.away : null
    };
  })
  .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));

await writeFile("data/matches.json", JSON.stringify(matches, null, 2) + "\n", "utf8");

const finished = matches.filter((m) => m.homeScore !== null).length;
console.log(`Zapisano ${matches.length} meczów (z wynikiem: ${finished}).`);
