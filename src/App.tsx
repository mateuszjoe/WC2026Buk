import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import { calculateLeaderboard, scoreMatchPrediction } from "./lib/scoring";
import {
  createPlayerExport,
  downloadJson,
  mergePlayerExports,
  normalizePredictionsFile,
  parsePlayerExport,
  readJsonFile,
  validatePredictionTimings
} from "./lib/importExport";
import {
  loadLocalPlayer,
  loadLocalPredictions,
  saveLocalPlayer,
  saveLocalPredictions
} from "./lib/storage";
import type {
  ChampionPrediction,
  ImportWarning,
  LeaderboardRow,
  Match,
  MatchPrediction,
  Player,
  PlayerExport,
  PredictionsFile,
  Settings,
  Team
} from "./lib/types";

type ViewId = "dashboard" | "matches" | "my-predictions" | "leaderboard" | "admin";
type MatchFilter = "all" | "upcoming" | "finished";

interface AppData {
  matches: Match[];
  players: Player[];
  predictions: PredictionsFile;
  settings: Settings;
}

const EMPTY_PLAYER: Player = {
  id: "",
  name: ""
};

const NAV_ITEMS: Array<{ id: ViewId; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "matches", label: "Mecze" },
  { id: "my-predictions", label: "Moje typy" },
  { id: "leaderboard", label: "Ranking" },
  { id: "admin", label: "Import/Admin" }
];

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [data, setData] = useState<AppData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localPlayer, setLocalPlayer] = useState<Player>(
    () => loadLocalPlayer() ?? EMPTY_PLAYER
  );
  const [localPredictions, setLocalPredictions] = useState<PredictionsFile>(() =>
    loadLocalPredictions()
  );

  useEffect(() => {
    let ignore = false;

    async function loadData() {
      try {
        const [settings, matches, players, rawPredictions] = await Promise.all([
          fetchJson<Settings>("settings.json"),
          fetchJson<Match[]>("matches.json"),
          fetchJson<Player[]>("players.json"),
          fetchJson<unknown>("predictions.json")
        ]);

        if (!ignore) {
          setData({
            settings,
            matches: [...matches].sort((left, right) =>
              left.kickoffAt.localeCompare(right.kickoffAt)
            ),
            players,
            predictions: normalizePredictionsFile(rawPredictions)
          });
        }
      } catch (error) {
        if (!ignore) {
          setLoadError(
            error instanceof Error ? error.message : "Nie udało się wczytać danych."
          );
        }
      }
    }

    loadData();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    saveLocalPlayer(localPlayer);
  }, [localPlayer]);

  useEffect(() => {
    saveLocalPredictions(localPredictions);
  }, [localPredictions]);

  const leaderboard = useMemo(
    () =>
      data
        ? calculateLeaderboard(
            data.players,
            data.matches,
            data.predictions,
            data.settings
          )
        : [],
    [data]
  );

  const knownTeams = useMemo(() => (data ? getTeams(data.matches) : []), [data]);
  const allPlayers = useMemo(
    () => (data ? getPlayersFromData(data.players, data.predictions) : []),
    [data]
  );

  if (loadError) {
    return (
      <main className="app-shell">
        <section className="empty-state">
          <p className="eyebrow">Błąd danych</p>
          <h1>Nie udało się uruchomić typera</h1>
          <p>{loadError}</p>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="app-shell">
        <section className="empty-state">
          <p className="eyebrow">Typer znajomych</p>
          <h1>Wczytywanie danych...</h1>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">Prywatny typer znajomych</p>
          <h1>{data.settings.tournamentName}</h1>
        </div>
        <nav className="tab-bar" aria-label="Główna nawigacja">
          {NAV_ITEMS.map((item) => (
            <button
              className={activeView === item.id ? "tab active" : "tab"}
              key={item.id}
              onClick={() => setActiveView(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {activeView === "dashboard" && (
        <DashboardView
          data={data}
          leaderboard={leaderboard}
          onNavigate={setActiveView}
        />
      )}
      {activeView === "matches" && (
        <MatchesView data={data} players={allPlayers} />
      )}
      {activeView === "my-predictions" && (
        <MyPredictionsView
          data={data}
          teams={knownTeams}
          localPlayer={localPlayer}
          localPredictions={localPredictions}
          setLocalPlayer={setLocalPlayer}
          setLocalPredictions={setLocalPredictions}
        />
      )}
      {activeView === "leaderboard" && (
        <LeaderboardView leaderboard={leaderboard} settings={data.settings} />
      )}
      {activeView === "admin" && <AdminView data={data} />}
    </main>
  );
}

function DashboardView({
  data,
  leaderboard,
  onNavigate
}: {
  data: AppData;
  leaderboard: LeaderboardRow[];
  onNavigate: (view: ViewId) => void;
}) {
  const finishedMatches = data.matches.filter(isMatchFinished).length;
  const nextMatches = data.matches.filter((match) => !isMatchFinished(match)).slice(0, 3);

  return (
    <section className="view-stack">
      <div className="metric-grid">
        <article className="metric-card">
          <span>Mecze</span>
          <strong>{data.matches.length}</strong>
        </article>
        <article className="metric-card">
          <span>Gracze</span>
          <strong>{data.players.length}</strong>
        </article>
        <article className="metric-card">
          <span>Zakończone</span>
          <strong>{finishedMatches}</strong>
        </article>
        <article className="metric-card">
          <span>Lider</span>
          <strong>{leaderboard[0]?.playerName ?? "Brak"}</strong>
        </article>
      </div>

      <section className="content-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Szybki start</p>
            <h2>Co chcesz zrobić?</h2>
          </div>
        </div>
        <div className="quick-actions">
          <button type="button" onClick={() => onNavigate("matches")}>
            Przejdź do meczów
          </button>
          <button type="button" onClick={() => onNavigate("my-predictions")}>
            Wpisz moje typy
          </button>
          <button type="button" onClick={() => onNavigate("leaderboard")}>
            Zobacz ranking
          </button>
          <button type="button" onClick={() => onNavigate("admin")}>
            Scal pliki graczy
          </button>
        </div>
      </section>

      <section className="content-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Najbliższe mecze</p>
            <h2>Terminarz testowy</h2>
          </div>
        </div>
        {nextMatches.length === 0 ? (
          <p className="muted">Brak nadchodzących meczów.</p>
        ) : (
          <div className="compact-list">
            {nextMatches.map((match) => (
              <div className="compact-row" key={match.id}>
                <span>{formatDate(match.kickoffAt)}</span>
                <strong>
                  {match.homeTeam.name} - {match.awayTeam.name}
                </strong>
                <span>{formatStage(match)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function MatchesView({ data, players }: { data: AppData; players: Player[] }) {
  const [filter, setFilter] = useState<MatchFilter>("all");
  const visibleMatches = data.matches.filter((match) => {
    if (filter === "finished") {
      return isMatchFinished(match);
    }
    if (filter === "upcoming") {
      return !isMatchFinished(match);
    }
    return true;
  });

  return (
    <section className="view-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Terminarz i wyniki</p>
          <h2>Mecze</h2>
        </div>
        <div className="segmented-control" role="group" aria-label="Filtr meczów">
          {[
            ["all", "Wszystkie"],
            ["upcoming", "Nadchodzące"],
            ["finished", "Zakończone"]
          ].map(([id, label]) => (
            <button
              className={filter === id ? "active" : ""}
              key={id}
              onClick={() => setFilter(id as MatchFilter)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="match-list">
        {visibleMatches.map((match) => {
          const finished = isMatchFinished(match);

          return (
            <article className="match-card" key={match.id}>
              <div className="match-main">
                <div className="match-meta">
                  <span>{formatDate(match.kickoffAt)}</span>
                  <span>{formatStage(match)}</span>
                  <span className={`status-badge ${match.status}`}>{match.status}</span>
                </div>
                <div className="match-teams">
                  <strong>{match.homeTeam.name}</strong>
                  <span>{formatScore(match)}</span>
                  <strong>{match.awayTeam.name}</strong>
                </div>
              </div>

              {finished && (
                <div className="points-strip">
                  {players.map((player) => {
                    const prediction = getLatestMatchPrediction(
                      data.predictions.matchPredictions,
                      player.id,
                      match.id
                    );
                    const score = scoreMatchPrediction(prediction, match, data.settings);

                    return (
                      <span key={player.id}>
                        {player.name}: <strong>{score.points}</strong>
                      </span>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function MyPredictionsView({
  data,
  teams,
  localPlayer,
  localPredictions,
  setLocalPlayer,
  setLocalPredictions
}: {
  data: AppData;
  teams: Team[];
  localPlayer: Player;
  localPredictions: PredictionsFile;
  setLocalPlayer: Dispatch<SetStateAction<Player>>;
  setLocalPredictions: Dispatch<SetStateAction<PredictionsFile>>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const matchPredictionsById = useMemo(() => {
    const predictions = new Map<string, MatchPrediction>();

    for (const prediction of localPredictions.matchPredictions) {
      if (!localPlayer.id || prediction.playerId === localPlayer.id) {
        predictions.set(prediction.matchId, prediction);
      }
    }

    return predictions;
  }, [localPlayer.id, localPredictions.matchPredictions]);

  const championPrediction = useMemo(
    () =>
      localPredictions.championPredictions.find(
        (prediction) => prediction.playerId === localPlayer.id
      ) ?? localPredictions.championPredictions[0],
    [localPlayer.id, localPredictions.championPredictions]
  );

  function updatePlayer(field: keyof Player, value: string) {
    const nextPlayer = {
      ...localPlayer,
      [field]: field === "id" ? sanitizePlayerId(value) : value
    };

    setLocalPlayer(nextPlayer);

    if (field === "id" && nextPlayer.id) {
      setLocalPredictions((current) => ({
        matchPredictions: current.matchPredictions.map((prediction) => ({
          ...prediction,
          playerId: nextPlayer.id
        })),
        championPredictions: current.championPredictions.map((prediction) => ({
          ...prediction,
          playerId: nextPlayer.id
        }))
      }));
    }
  }

  function updateMatchPrediction(
    match: Match,
    field: "predictedHomeScore" | "predictedAwayScore",
    rawValue: string
  ) {
    if (!localPlayer.id || isMatchLocked(match, data.settings)) {
      return;
    }

    setLocalPredictions((current) => {
      const existing = current.matchPredictions.find(
        (prediction) =>
          prediction.playerId === localPlayer.id && prediction.matchId === match.id
      );
      const remaining = current.matchPredictions.filter(
        (prediction) =>
          !(prediction.playerId === localPlayer.id && prediction.matchId === match.id)
      );

      if (rawValue === "") {
        return {
          ...current,
          matchPredictions: remaining
        };
      }

      const parsedScore = Number(rawValue);

      if (!Number.isFinite(parsedScore)) {
        return current;
      }

      const score = Math.max(0, Math.trunc(parsedScore));
      const nextPrediction: MatchPrediction = {
        playerId: localPlayer.id,
        matchId: match.id,
        predictedHomeScore:
          field === "predictedHomeScore"
            ? score
            : existing?.predictedHomeScore ?? 0,
        predictedAwayScore:
          field === "predictedAwayScore"
            ? score
            : existing?.predictedAwayScore ?? 0,
        updatedAt: new Date().toISOString()
      };

      return {
        ...current,
        matchPredictions: [...remaining, nextPrediction]
      };
    });

    setNotice("Zapisano typ w localStorage.");
  }

  function updateChampionPrediction(championTeamId: string) {
    if (!localPlayer.id) {
      return;
    }

    setLocalPredictions((current) => {
      const remaining = current.championPredictions.filter(
        (prediction) => prediction.playerId !== localPlayer.id
      );

      if (!championTeamId) {
        return {
          ...current,
          championPredictions: remaining
        };
      }

      const nextPrediction: ChampionPrediction = {
        playerId: localPlayer.id,
        championTeamId,
        updatedAt: new Date().toISOString()
      };

      return {
        ...current,
        championPredictions: [...remaining, nextPrediction]
      };
    });

    setNotice("Zapisano typ zwycięzcy w localStorage.");
  }

  function exportMyPredictions() {
    if (!localPlayer.id || !localPlayer.name.trim()) {
      setNotice("Najpierw wpisz playerId i nazwę gracza.");
      return;
    }

    downloadJson(
      `${localPlayer.id}-typy-ms-2026.json`,
      createPlayerExport(
        {
          id: localPlayer.id,
          name: localPlayer.name.trim()
        },
        localPredictions
      )
    );
  }

  async function importMyPredictions(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    try {
      const parsed = await readJsonFile(file);
      const playerExport = parsePlayerExport(parsed);

      if (!playerExport) {
        setNotice("Ten plik nie wygląda jak eksport typów gracza.");
        return;
      }

      setLocalPlayer(playerExport.player);
      setLocalPredictions({
        matchPredictions: playerExport.matchPredictions,
        championPredictions: playerExport.championPredictions
      });
      setNotice("Zaimportowano moje typy z JSON.");
    } catch {
      setNotice("Nie udało się odczytać pliku JSON.");
    } finally {
      event.currentTarget.value = "";
    }
  }

  return (
    <section className="view-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">LocalStorage i eksport JSON</p>
          <h2>Moje typy</h2>
        </div>
        <div className="button-row">
          <button type="button" onClick={exportMyPredictions}>
            Eksportuj moje typy do JSON
          </button>
          <label className="button secondary">
            Importuj moje typy z JSON
            <input
              accept="application/json"
              className="visually-hidden"
              onChange={importMyPredictions}
              type="file"
            />
          </label>
        </div>
      </div>

      <section className="content-panel">
        <div className="form-grid">
          <label>
            <span>playerId</span>
            <input
              autoComplete="off"
              placeholder="janek"
              value={localPlayer.id}
              onChange={(event) => updatePlayer("id", event.target.value)}
            />
          </label>
          <label>
            <span>Nazwa</span>
            <input
              autoComplete="off"
              placeholder="Janek"
              value={localPlayer.name}
              onChange={(event) => updatePlayer("name", event.target.value)}
            />
          </label>
          <label>
            <span>Zwycięzca turnieju</span>
            <select
              disabled={!localPlayer.id}
              value={championPrediction?.championTeamId ?? ""}
              onChange={(event) => updateChampionPrediction(event.target.value)}
            >
              <option value="">Brak typu</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name} ({team.id})
                </option>
              ))}
            </select>
          </label>
        </div>
        {notice && <p className="notice">{notice}</p>}
      </section>

      <section className="content-panel">
        <div className="section-head compact">
          <div>
            <p className="eyebrow">Typy meczowe</p>
            <h2>Wyniki meczów</h2>
          </div>
        </div>
        <div className="prediction-list">
          {data.matches.map((match) => {
            const prediction = matchPredictionsById.get(match.id);
            const locked = isMatchLocked(match, data.settings);

            return (
              <div className="prediction-row" key={match.id}>
                <div>
                  <span className="row-date">{formatDate(match.kickoffAt)}</span>
                  <strong>
                    {match.homeTeam.name} - {match.awayTeam.name}
                  </strong>
                  <span className={locked ? "lock-label locked" : "lock-label"}>
                    {locked ? "Zablokowane" : formatStage(match)}
                  </span>
                </div>
                <div className="score-inputs">
                  <input
                    disabled={!localPlayer.id || locked}
                    inputMode="numeric"
                    min="0"
                    type="number"
                    value={prediction?.predictedHomeScore ?? ""}
                    onChange={(event) =>
                      updateMatchPrediction(
                        match,
                        "predictedHomeScore",
                        event.target.value
                      )
                    }
                    aria-label={`Typ gospodarzy dla ${match.id}`}
                  />
                  <span>:</span>
                  <input
                    disabled={!localPlayer.id || locked}
                    inputMode="numeric"
                    min="0"
                    type="number"
                    value={prediction?.predictedAwayScore ?? ""}
                    onChange={(event) =>
                      updateMatchPrediction(
                        match,
                        "predictedAwayScore",
                        event.target.value
                      )
                    }
                    aria-label={`Typ gości dla ${match.id}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function LeaderboardView({
  leaderboard,
  settings
}: {
  leaderboard: LeaderboardRow[];
  settings: Settings;
}) {
  return (
    <section className="view-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Punkty liczone w przeglądarce</p>
          <h2>Ranking</h2>
        </div>
        <div className="points-note">
          {settings.points.exactScore} pkt dokładny wynik,{" "}
          {settings.points.correctResult} pkt rezultat,{" "}
          {settings.points.tournamentWinner} pkt zwycięzca
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Miejsce</th>
              <th>Gracz</th>
              <th>Suma</th>
              <th>Mecze</th>
              <th>Zwycięzca</th>
              <th>Dokładne</th>
              <th>Rezultaty</th>
            </tr>
          </thead>
          <tbody>
            {leaderboard.map((row) => (
              <tr key={row.playerId}>
                <td>{row.rank}</td>
                <td>{row.playerName}</td>
                <td>
                  <strong>{row.totalPoints}</strong>
                </td>
                <td>{row.matchPoints}</td>
                <td>{row.championPoints}</td>
                <td>{row.exactScoreCount}</td>
                <td>{row.correctOutcomeCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AdminView({ data }: { data: AppData }) {
  const [result, setResult] = useState<{
    players: Player[];
    predictions: PredictionsFile;
    warnings: ImportWarning[];
    importedCount: number;
    rejectedFiles: string[];
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    const parsedExports: PlayerExport[] = [];
    const rejectedFiles: string[] = [];

    for (const file of files) {
      try {
        const parsed = await readJsonFile(file);
        const playerExport = parsePlayerExport(parsed);

        if (playerExport) {
          parsedExports.push(playerExport);
        } else {
          rejectedFiles.push(file.name);
        }
      } catch {
        rejectedFiles.push(file.name);
      }
    }

    const merged = mergePlayerExports(
      parsedExports,
      data.players,
      data.predictions
    );
    const warnings = validatePredictionTimings(
      merged.predictions.matchPredictions,
      data.matches
    );

    setResult({
      ...merged,
      warnings,
      importedCount: parsedExports.length,
      rejectedFiles
    });
    setMessage(
      parsedExports.length
        ? `Wczytano ${parsedExports.length} plików graczy.`
        : "Nie wczytano żadnego poprawnego eksportu gracza."
    );
    event.currentTarget.value = "";
  }

  return (
    <section className="view-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Bez backendu i bazy danych</p>
          <h2>Import/Admin</h2>
        </div>
        <label className="button">
          Wgraj pliki JSON graczy
          <input
            accept="application/json"
            className="visually-hidden"
            multiple
            onChange={importFiles}
            type="file"
          />
        </label>
      </div>

      <section className="content-panel">
        <p>
          Admin zbiera od znajomych pliki wyeksportowane w widoku Moje typy,
          wgrywa je tutaj, pobiera scalony JSON i ręcznie podmienia pliki w
          repozytorium. Bez backendu aplikacja nie zapisuje niczego na serwerze.
        </p>
        <ol className="instruction-list">
          <li>Wgraj wiele plików JSON od graczy.</li>
          <li>Pobierz scalone predictions.json.</li>
          <li>Jeśli doszli nowi gracze, pobierz też players.json.</li>
          <li>Podmień pliki w public/data, zrób commit i push do GitHuba.</li>
        </ol>
        {message && <p className="notice">{message}</p>}
      </section>

      {result && (
        <section className="content-panel">
          <div className="admin-summary">
            <div>
              <span>Gracze</span>
              <strong>{result.players.length}</strong>
            </div>
            <div>
              <span>Typy meczów</span>
              <strong>{result.predictions.matchPredictions.length}</strong>
            </div>
            <div>
              <span>Typy zwycięzcy</span>
              <strong>{result.predictions.championPredictions.length}</strong>
            </div>
            <div>
              <span>Ostrzeżenia</span>
              <strong>{result.warnings.length}</strong>
            </div>
          </div>

          <div className="button-row">
            <button
              type="button"
              onClick={() => downloadJson("predictions.json", result.predictions)}
            >
              Pobierz scalone predictions.json
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() => downloadJson("players.json", result.players)}
            >
              Pobierz scalone players.json
            </button>
          </div>

          {result.rejectedFiles.length > 0 && (
            <div className="warning-box">
              <strong>Odrzucone pliki:</strong>
              <p>{result.rejectedFiles.join(", ")}</p>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="warning-box">
              <strong>Walidator typów po kickoffie</strong>
              <ul>
                {result.warnings.map((warning) => (
                  <li key={`${warning.playerId}-${warning.matchId}-${warning.message}`}>
                    {warning.playerId} / {warning.matchId}: {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

async function fetchJson<T>(filename: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}data/${filename}`);

  if (!response.ok) {
    throw new Error(`Nie można wczytać public/data/${filename}.`);
  }

  return (await response.json()) as T;
}

function getTeams(matches: Match[]): Team[] {
  const teamById = new Map<string, Team>();

  for (const match of matches) {
    teamById.set(match.homeTeam.id, match.homeTeam);
    teamById.set(match.awayTeam.id, match.awayTeam);
  }

  return Array.from(teamById.values()).sort((left, right) =>
    left.name.localeCompare(right.name, "pl") || left.id.localeCompare(right.id, "pl")
  );
}

function getPlayersFromData(players: Player[], predictions: PredictionsFile): Player[] {
  const playerById = new Map(players.map((player) => [player.id, player]));

  for (const prediction of predictions.matchPredictions) {
    if (!playerById.has(prediction.playerId)) {
      playerById.set(prediction.playerId, {
        id: prediction.playerId,
        name: prediction.playerId
      });
    }
  }

  for (const prediction of predictions.championPredictions) {
    if (!playerById.has(prediction.playerId)) {
      playerById.set(prediction.playerId, {
        id: prediction.playerId,
        name: prediction.playerId
      });
    }
  }

  return Array.from(playerById.values()).sort((left, right) =>
    left.name.localeCompare(right.name, "pl")
  );
}

function getLatestMatchPrediction(
  predictions: MatchPrediction[],
  playerId: string,
  matchId: string
): MatchPrediction | undefined {
  return predictions
    .filter(
      (prediction) =>
        prediction.playerId === playerId && prediction.matchId === matchId
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function isMatchFinished(match: Match) {
  return (
    match.status === "finished" ||
    (typeof match.homeScore === "number" && typeof match.awayScore === "number")
  );
}

function isMatchLocked(match: Match, settings: Settings) {
  if (!settings.lockPredictionsAtKickoff) {
    return false;
  }

  return Date.now() >= Date.parse(match.kickoffAt);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatStage(match: Match) {
  return match.group ? `${match.stage}, grupa ${match.group}` : match.stage;
}

function formatScore(match: Match) {
  if (typeof match.homeScore !== "number" || typeof match.awayScore !== "number") {
    return "-";
  }

  return `${match.homeScore}:${match.awayScore}`;
}

function sanitizePlayerId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}
