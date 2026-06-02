# Typer MŚ 2026

Prosty, statyczny typer dla znajomych na Mistrzostwa Świata 2026. Projekt nie ma logowania, backendu, zewnętrznej bazy danych, prawdziwych pieniędzy, kursów ani płatności. Strona czyta pliki JSON z repozytorium, liczy ranking w przeglądarce, a pojedynczy gracz zapisuje swoje typy lokalnie w `localStorage` i eksportuje je do JSON.

## Uruchomienie lokalne

```bash
npm install
npm run dev
```

Po uruchomieniu Vite pokaże lokalny adres, zwykle `http://localhost:5173/`.

Build produkcyjny:

```bash
npm run build
```

## Struktura danych

Dane są w `public/data`:

- `settings.json` - nazwa turnieju, punktacja, blokada typów po kickoffie, zwycięzca turnieju.
- `matches.json` - terminarz, statusy i wyniki meczów.
- `players.json` - lista graczy.
- `predictions.json` - scalone typy meczów i typy zwycięzcy turnieju.

Typy w `predictions.json` są trzymane pod kluczami:

```json
{
  "matchPredictions": [],
  "championPredictions": []
}
```

## Jak dodać graczy

Ręcznie edytuj `public/data/players.json`:

```json
[
  {
    "id": "janek",
    "name": "Janek"
  },
  {
    "id": "ania",
    "name": "Ania"
  }
]
```

`id` powinno być krótkie i stabilne, np. `janek`, `ania`, `mateusz`.

## Jak zebrać typy od znajomych

1. Gracz uruchamia stronę i przechodzi do widoku `Moje typy`.
2. Wpisuje `playerId`, nazwę, typy wyników oraz zwycięzcę turnieju.
3. Klika `Eksportuj moje typy do JSON`.
4. Wysyła plik adminowi grupy.
5. Admin wchodzi w `Import/Admin`, wgrywa wiele plików JSON i pobiera scalone `predictions.json`.
6. Admin podmienia `public/data/predictions.json`, robi commit i push.

Jeśli w eksportach pojawili się nowi gracze, admin może też pobrać scalone `players.json` i podmienić `public/data/players.json`.

## Jak zaktualizować wyniki meczów

Edytuj ręcznie `public/data/matches.json`. Po zakończonym meczu ustaw:

```json
{
  "status": "finished",
  "homeScore": 2,
  "awayScore": 1
}
```

Jeśli mecz jeszcze nie ma wyniku, zostaw:

```json
{
  "status": "scheduled",
  "homeScore": null,
  "awayScore": null
}
```

Po aktualizacji wyników zrób commit i push. Ranking przeliczy się automatycznie w przeglądarce.

## Jak ustawić zwycięzcę turnieju

Po finale edytuj `public/data/settings.json` i ustaw `championTeamId` na identyfikator zwycięskiej drużyny:

```json
{
  "championTeamId": "team-001"
}
```

Dopiero wtedy aplikacja doliczy punkty za zwycięzcę turnieju.

## GitHub Pages

Projekt ma gotowy workflow w `.github/workflows/deploy.yml`.

Pierwsza publikacja:

1. Utwórz nowe repozytorium na GitHubie.
2. Jeśli repozytorium nie jest stroną typu `twoj-login.github.io`, otwórz `vite.config.ts` i ustaw `base` na nazwę repozytorium, np.:

```ts
base: "/wc-2026-buk/";
```

3. Zainicjalizuj Git lokalnie i wypchnij projekt:

```bash
git init
git add .
git commit -m "Initial World Cup 2026 typer MVP"
git branch -M main
git remote add origin https://github.com/TWOJ_LOGIN/NAZWA_REPO.git
git push -u origin main
```

4. Na GitHubie wejdź w `Settings` -> `Pages`.
5. W `Build and deployment` wybierz `GitHub Actions`.
6. Wejdź w zakładkę `Actions` i poczekaj, aż workflow `Deploy to GitHub Pages` zakończy się sukcesem.
7. Adres strony będzie widoczny w `Settings` -> `Pages` oraz w podsumowaniu workflow.

## Ograniczenie bezpieczeństwa

Bez backendu blokada typów po `kickoffAt` jest oparta na zaufaniu i walidacji JSON. UI blokuje edycję typów po rozpoczęciu meczu, a panel admina ostrzega, gdy `updatedAt` jest późniejsze niż `kickoffAt`, ale nie jest to zabezpieczenie przed ręczną edycją plików JSON.
