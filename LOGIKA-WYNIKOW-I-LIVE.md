# Logika zaczytywania wyników i wyników „na żywo” (do przeniesienia do innego typera)

> Dokument opisuje **dokładnie** jak w tym typerze (WC2026Buk, Firebase + GitHub
> Pages) działa pobieranie wyników meczów: końcowych i live. Zrób to samo w drugim
> typerze, a live i ranking będą działać poprawnie. Pliki źródłowe:
> `scripts/update-data.mjs` (robot), `functions/index.js` (Cloud Function live),
> `app.js` (klient), `data/matches.json`, `data/settings.json`, `sw.js`.

---

## 1. Dwa tory danych (to jest sedno)

Wynik dociera do gracza **dwoma niezależnymi kanałami**, co daje i niezawodność,
i natychmiastowość:

1. **Plik `data/matches.json`** — „prawda” o terminarzu i **wynikach końcowych**.
   - Aktualizuje go robot (GitHub Actions, `scripts/update-data.mjs`) i commituje
     do repo → GitHub Pages serwuje nowy plik.
   - Klient czyta go przy starcie i cyklicznie (polling co kilka minut).
   - **Bez minuty meczu** (`liveElapsed` jest wycinane) — żeby plik nie zmieniał
     się co sekundę i robot nie commitował w kółko. Plik zmienia się tylko przy
     realnej zmianie wyniku/statusu.

2. **Dokument Firestore `live/state`** — **nakładka „na żywo”** (gole w trakcie).
   - Pisany przez robota ORAZ przez Cloud Function `liveScorePoll` (co 1 min).
   - Klient słucha go przez `onSnapshot` → gol pojawia się **natychmiast** (i push),
     bez czekania na commit pliku i przebudowę Pages.
   - Trzyma **tylko mecze w oknie live** (krótka mapa `matchId -> {...}`).

Klient łączy oba tory: `state.matches = baseMatches (plik) + nakładka live (Firestore)`.

```
football-data.org ─┐
ESPN scoreboard   ─┼─> robot (update-data.mjs) ─> data/matches.json ─> Pages ─┐
API-Football      ─┘                            └─> Firestore live/state ─┐    │
Cloud Function liveScorePoll (co 1 min) ──────────> Firestore live/state ─┼─> KLIENT (app.js)
                                                                          │    │
                                          onSnapshot(live/state) ─────────┘    │
                                          fetch(data/matches.json) ────────────┘
                                                     │
                                          applyLiveOverlay() -> state.matches
```

---

## 2. Źródła wyników (i dlaczego akurat te)

| Źródło | Po co | Klucz | Uwagi |
|---|---|---|---|
| **football-data.org** (`/v4/competitions/WC/matches`) | terminarz + wynik **końcowy**, etap, grupa, kolejka, `duration`, `winner` | `FOOTBALL_DATA_TOKEN` (sekret) | Plan free **NIE podaje wyniku w trakcie meczu** (tylko po końcu). |
| **ESPN scoreboard** (nieoficjalne, darmowe, bez klucza) | **LIVE**: status, wynik bieżący, minuta | brak | Główne źródło live. Udostępnia CORS (klient też może czytać). |
| **API-Football (API-Sports)** | dodatkowy live (gdy masz płatny klucz) | `API_FOOTBALL_KEY` (opcjonalny) | Free nie ma sezonu 2026. Nakładany przed ESPN; ESPN ma pierwszeństwo. |

Kolejność nakładania w robocie: `football-data (baza) → API-Football → ESPN (na
końcu, wygrywa)`.

**Ważny szczegół ESPN:** grupuje mecze wg daty US (strefa za UTC), więc mecz nocny
UTC trafia u nich pod **poprzedni** dzień. Dlatego pytamy o dzień meczu **i** dzień
wcześniej (`dates.add(t)` oraz `dates.add(t - 24h)`).

Dopasowanie meczu ESPN/API ↔ nasz mecz: po **znormalizowanej nazwie** obu drużyn
(`norm()`: PL→EN mapa, lower, bez ogonków, bez nie-alfanum) **plus** zbliżony
czas gwizdka (`±3 h`, `closeKickoff`). Bez tego dochodzi do błędnych dopasowań.

---

## 3. Statusy i pola meczu (kontrakt danych)

Każdy mecz w `matches.json` / `live/state` ma:

- `status`: `TIMED`/`SCHEDULED` (przed), `IN_PLAY`, `PAUSED` (przerwa),
  `FINISHED`, `AWARDED` (walkower).
  - **LIVE** = `{IN_PLAY, PAUSED}` (`LIVE_MATCH_STATUSES`)
  - **KOŃCOWY** = `{FINISHED, AWARDED}` (`FINAL_MATCH_STATUSES`)
- `homeScore` / `awayScore` — wynik **bieżący** (w trakcie) lub **końcowy** (po końcu).
  W football-data.org `score.fullTime` jest jednocześnie wynikiem bieżącym podczas
  `IN_PLAY` — dlatego sam status nie wystarczy, patrz §4.
- `regularHomeScore` / `regularAwayScore` — wynik **po 90'** (`score.regularTime`),
  potrzebny w pucharach (patrz §5).
- `duration`: `REGULAR` | `EXTRA_TIME` | `PENALTY_SHOOTOUT`.
- `winner`: `HOME_TEAM` | `AWAY_TEAM` | `DRAW` | null — faktyczny zwycięzca (też po
  dogrywce/karnych); do „kto awansuje” i mistrza.
- `liveElapsed` — minuta (tylko w `live/state`, NIE w pliku).

---

## 4. Wyliczanie wyniku po stronie klienta (NAJWAŻNIEJSZE)

Trzy funkcje, hierarchia źródeł. Przenieś je 1:1.

```js
// Wynik do OSTATECZNEJ punktacji (ranking finalny, „było 2:1”).
function getResult(match) {
  const override = adminResult(match);          // 1) ręczna korekta admina (Firestore admin/state.results)
  if (override) return override;
  if (!isFinalStatus(match)) return undefined;  // 2) tylko mecz ZAKOŃCZONY ma wynik końcowy
  if (match.duration && match.duration !== "REGULAR")
    return regularTimeResult(match);            // 3) puchar po dogrywce -> liczy się 90' (regularTime); brak -> czekaj na admina
  return apiFullTimeResult(match);              // 4) normalnie: fullTime z pliku
}

// Wynik do PODGLĄDU i RANKINGU LIVE (gole w trakcie).
function getLiveResult(match) {
  const final = getResult(match);
  if (final) return final;                      // mecz już skończony -> użyj końcowego
  if (!isLiveMatch(match)) return undefined;    // nie trwa -> brak
  if (match.duration && match.duration !== "REGULAR")
    return regularTimeResult(match) || apiFullTimeResult(match);
  return apiFullTimeResult(match);              // w trakcie: bieżący fullTime
}

// Czy mecz ma już wynik końcowy (do blokad/etykiet).
function matchFinished(match) { return Boolean(getResult(match)); }
```

Klucz: **`getResult` zwraca coś TYLKO dla statusu końcowego** (albo korekty
admina). W trakcie meczu `score.fullTime` to wynik bieżący i **nie może udawać
końca** — dlatego live czytamy osobno przez `getLiveResult`.

Ranking: `resultForLeaderboard(match, includeLive)` — bez `includeLive` liczy
tylko wyniki końcowe; z `includeLive` (gdy są mecze LIVE) dolicza tymczasowe
punkty live. Stąd „Ranking live” i `livePoints` (delta „+X live”), które znikają
po końcowym gwizdku.

---

## 5. Faza pucharowa — czas regulaminowy (częste źródło błędów)

- Typy dotyczą **90 minut**. Dogrywka i karne **nie liczą się** do punktów za
  wynik/rezultat.
- Technicznie: jeśli `duration != REGULAR`, auto-wynik z API zawiera dogrywkę →
  **nie używamy go**; bierzemy `regularTime` (remis 90'). Jeśli API nie poda
  `regularTime` — wynik wpisuje **admin ręcznie** (Firestore `admin/state.results`).
- **Mistrz turnieju** i **„kto awansuje”** = faktyczny zwycięzca z pola `winner`
  (tu dogrywka/karne **liczą się**).

---

## 6. Robot `scripts/update-data.mjs` — zabezpieczenia (KONIECZNIE przenieś)

To są wnioski z produkcji; bez nich „znikają” terminarz/typy albo ranking się zeruje:

1. **Nie nadpisuj pustką.** Jeśli API zwróci podejrzanie mało meczów
   (`matches.length < 64` przy MŚ = 104) — **pomiń zapis** i zakończ `exit 0`.
2. **Nie wywalaj joba.** Łap `unhandledRejection`/`uncaughtException` oraz błędy
   HTTP/`fetch failed` → `console.warn` + `exit 0` (zostaje ostatnia dobra wersja),
   żeby GitHub nie słał maili o błędach.
3. **STICKY FINALS — nie cofaj zakończonego meczu.** Po meczu ESPN milknie, a
   football-data free nie podaje wyniku → bez tego ranking się zerował. Czytamy
   **poprzedni** `matches.json` i jeśli mecz był `FINISHED/AWARDED` z liczbowym
   wynikiem, a nowy build go nie ma — **zachowujemy stary wynik końcowy**.
4. **Do pliku bez `liveElapsed`** (minuty) — inaczej plik zmienia się co minutę.
5. **Okna czasowe** (oszczędzanie limitów API):
   - live/pętla: od **15 min przed** do **150 min po** gwizdku,
   - ESPN: do **8 h po** (żeby utrwalić wynik końcowy),
   - `live-window.flag` — gdy okno otwarte, workflow pętli polling co kilka minut
     (goły cron GitHuba bywa dławiony do co 2–3 h — za rzadko na live).
6. `process.exit(0)` na końcu — `firebase-admin` trzyma gRPC i blokuje wyjście.

---

## 7. Cloud Function `liveScorePoll` — niezawodny live (co 1 min)

`functions/index.js`, `onSchedule("every 1 minutes", region europe-west1)`:

- Pobiera terminarz (`raw matches.json` z GitHuba), wybiera mecze w oknie
  (−15 min … +6 h), dociąga ESPN dla tych dat (dzień i dzień wcześniej),
  dopasowuje po nazwach+czasie i zapisuje mapę do `live/state`.
- Działa **niezależnie od GitHub Actions** (cron GitHuba bywa dławiony) — dzięki
  temu ranking live działa nawet gdy robot śpi.
- Zapis `live/state` automatycznie odpala `onLiveScore` → push „⚽ GOL!”.

Dodatkowo zdarzeniowe pushe (też w `functions/index.js`):
- `onChatMessage` (nowa wiadomość czatu → push, `url: "./#chat"`),
- `onLiveScore` (wzrost sumy bramek w `live/state` → push o golu).

Wymaga planu **Blaze** + sekretu `VAPID_PRIVATE_KEY`.

---

## 8. Klient `app.js` — montaż i nasłuch

```js
// Start: wczytaj plik (terminarz + wyniki końcowe).
async function loadStaticData() {
  const [settings, matches] = await Promise.all([
    fetch("./data/settings.json").then(r => r.json()),
    fetch("./data/matches.json").then(r => r.json())
  ]);
  state.settings = settings;
  state.baseMatches = [...matches].sort((a,b) => a.kickoffAt.localeCompare(b.kickoffAt));
  applyLiveOverlay();
}

// Nakładka live na surowe dane z pliku. Mecz ZAKOŃCZONY w pliku ma pierwszeństwo
// (nie nadpisujemy go danymi live).
function applyLiveOverlay() {
  const live = state.live || {};
  state.matches = state.baseMatches.map((m) => {
    const patch = live[m.id];
    if (!patch || isFinalStatus(m)) return m;   // <- final z pliku wygrywa
    return { ...m, ...patch };
  });
}

// Real-time live z Firestore (czyta KAŻDY — ranking publiczny -> start od wejścia).
function listenToLiveScores() {
  onSnapshot(doc(db, "live", "state"), (d) => {
    state.live = (d.data() || {}).matches || {};
    applyLiveOverlay();
    checkNotifications();
    if (state.view === "ranking" || state.view === "matches") render();
  });
}

// Plus: polling pliku co kilka minut (na wypadek, gdy ktoś ma otwartą apkę),
// żeby wpadały wyniki końcowe i powiadomienia o zakończonych meczach.
```

Punktacja (`data/settings.json`): `exactScore:3`, `correctResult:1`,
`advanceBonus:1`, `tournamentWinner:10`. Blokada typu: **5 min przed** gwizdkiem
(`LOCK_BEFORE_MS`). Mistrz: do `championLockAt`.

---

## 9. Checklista przeniesienia do drugiego typera

1. [ ] Robot pobiera terminarz **z osobnego źródła** wyniku końcowego (np.
       football-data) i **osobnego** live (ESPN — darmowe). Nie polegaj na jednym.
2. [ ] Zapisuj `duration`, `winner`, `regularHomeScore/awayScore` — bez nich
       puchary i awans liczą się źle.
3. [ ] Rozdziel `getResult` (końcowy, tylko status końcowy) od `getLiveResult`
       (bieżący, tylko gdy LIVE). To najczęstszy błąd — mylenie wyniku bieżącego
       z końcowym.
4. [ ] Live trzymaj w osobnym, lekkim kanale real-time (Firestore `live/state` /
       Supabase Realtime), bez minuty w pliku „prawdy”.
5. [ ] `applyLiveOverlay`: mecz **zakończony** w pliku ma pierwszeństwo nad live.
6. [ ] Zabezpieczenia robota (§6): próg min. liczby meczów, `exit 0` na błędach,
       **sticky finals**, brak `liveElapsed` w pliku.
7. [ ] ESPN: pytaj o dzień meczu **i dzień wcześniej**; dopasuj po nazwach (mapa
       PL↔EN, normalizacja) **+** `±3 h` od gwizdka.
8. [ ] Niezawodny live (cron co 1 min po stronie serwera), nie tylko cron CI.
