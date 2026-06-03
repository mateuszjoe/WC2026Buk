# Typer Mistrzostw Świata 2026 ⚽🏆

Prywatny typer ze znajomymi na MŚ 2026. Gra **na punkty** (bez prawdziwych pieniędzy,
kursów ani płatności). Znajomi **logują się kontem Google**, wpisują typy meczów oraz
mistrza turnieju, a wszystko **zapisuje się samo** we wspólnej darmowej bazie i na żywo
przelicza ranking.

- **Brak instalacji i builda** — to zwykła strona statyczna (`index.html` + `app.js` +
  `styles.css`). Wrzucasz na GitHub Pages i działa.
- **Logowanie Google** (bez haseł), dane we wspólnej bazie **Firebase / Firestore**
  (darmowy plan w zupełności wystarcza dla grupy znajomych).
- **Panel admina** (tylko dla Ciebie) do wpisywania wyników — bez żadnych commitów.

## Punktacja

- **3 pkt** — dokładny wynik (np. typujesz 2:1 i jest 2:1).
- **1 pkt** — trafiony rezultat (wygrana gospodarzy / remis / wygrana gości), ale nie dokładny wynik.
- **0 pkt** — nietrafiony rezultat.
- **10 pkt** — trafiony mistrz turnieju (doliczane dopiero, gdy admin ustawi zwycięzcę po finale).

Wartości punktów zmienisz w `data/settings.json`.

---

## Konfiguracja krok po kroku (raz, ~10 minut)

### 1. Załóż darmowy projekt Firebase

1. Wejdź na <https://console.firebase.google.com> → **Dodaj projekt** (nazwa dowolna).
2. W projekcie kliknij ikonę **`</>`** (*Dodaj aplikację → Web*), nadaj nazwę,
   **zarejestruj aplikację**.
3. Firebase pokaże obiekt `firebaseConfig` — skopiuj go.
4. Otwórz w repo plik **`firebase-config.js`** i wklej tam swoje wartości.

### 2. Włącz logowanie Google

W konsoli Firebase: **Authentication → Get started → Sign-in method →** włącz **Google**
→ *Save*.

### 3. Utwórz bazę i wgraj reguły

1. **Firestore Database → Utwórz bazę** (tryb produkcyjny, dowolna lokalizacja).
2. Zakładka **Rules** → wklej całą zawartość pliku **`firestore.rules`** z repo → **Publish**.
3. W `firestore.rules` (oraz w `data/settings.json`) podmień adres admina, jeśli to nie Ty
   masz wpisywać wyniki — pole `adminEmail`. **To Twój adres = panel admina.**

### 4. Dodaj domenę GitHub Pages do dozwolonych

Po opublikowaniu strony (sekcja niżej) wróć do: **Authentication → Settings →
Authorized domains → Add domain** i dodaj swój adres, np. `twojlogin.github.io`.
Bez tego logowanie Google na żywej stronie nie zadziała (lokalnie `localhost` jest już dozwolony).

---

## Uruchomienie lokalnie

To zwykłe pliki statyczne, ale przeglądarka blokuje moduły ES z `file://`, więc odpal
mały serwer lokalny w folderze projektu:

```bash
# dowolna z tych opcji:
python -m http.server 5173
# albo
npx serve .
```

Następnie otwórz `http://localhost:5173`.

---

## Jak grają znajomi

1. Wysyłasz im link do strony.
2. Klikają **Zaloguj przez Google**.
3. Wchodzą w **Moje typy**, wpisują wyniki i wybierają mistrza — **zapisuje się samo**.
4. Mecze blokują się automatycznie o godzinie rozpoczęcia.

Nie ma żadnego eksportu/importu plików ani scalania — wszystko jest we wspólnej bazie.

## Jak Ty (admin) wpisujesz wyniki

1. Zaloguj się swoim kontem (tym z `adminEmail`).
2. Pojawi się zakładka **Panel admina**.
3. Wpisz wyniki meczów — ranking przeliczy się od razu u wszystkich.
4. Po finale ustaw **mistrza turnieju** (dolicza 10 pkt trafiającym).

## Jak podmienić terminarz na prawdziwy

Edytuj **`data/matches.json`**. Każdy mecz:

```json
{
  "id": "match-001",
  "stage": "group",
  "group": "A",
  "kickoffAt": "2026-06-11T19:00:00.000Z",
  "homeTeam": { "id": "mex", "name": "Meksyk" },
  "awayTeam": { "id": "pol", "name": "Polska" }
}
```

- `id` meczu i `id` drużyn muszą być unikalne i stabilne.
- `kickoffAt` w formacie ISO (UTC) — po tej godzinie typ się blokuje.
- Lista drużyn do wyboru „mistrza" buduje się automatycznie z drużyn w meczach.

Po edycji zrób commit i push — to jedyna rzecz, którą zmienia się przez repo.
Wyniki i mistrza ustawiasz w panelu admina, nie tutaj.

---

## Publikacja na GitHub Pages (pierwszy raz)

```bash
git add .
git commit -m "Typer MŚ 2026 — wersja z logowaniem Google"
git push
```

Następnie na GitHubie:

1. **Settings → Pages**.
2. W **Build and deployment → Source** wybierz **Deploy from a branch**.
3. Branch: **main**, folder: **/(root)** → **Save**.
4. Po chwili pojawi się adres, np. `https://twojlogin.github.io/nazwa-repo/`.
5. Ten adres dodaj w Firebase (**Authorized domains**, krok 4 konfiguracji).

> Strona jest serwowana wprost z katalogu głównego — nie ma żadnego kroku budowania.

---

## Ograniczenie bezpieczeństwa

Blokada typów po rozpoczęciu meczu jest **po stronie aplikacji** (uczciwa zabawa) —
to nie jest twarda ochrona. Twardo natomiast działają **reguły Firestore**: każdy może
zapisać tylko własne typy, a wyniki meczów może ustawiać wyłącznie admin. Dane to typy
na punkty — żadnych pieniędzy ani wrażliwych informacji.
