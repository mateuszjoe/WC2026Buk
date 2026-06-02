import type {
  ChampionPrediction,
  ImportWarning,
  Match,
  MatchPrediction,
  Player,
  PlayerExport,
  PredictionsFile
} from "./types";

const EMPTY_PREDICTIONS: PredictionsFile = {
  matchPredictions: [],
  championPredictions: []
};

export function normalizePredictionsFile(input: unknown): PredictionsFile {
  if (Array.isArray(input)) {
    return {
      matchPredictions: normalizeMatchPredictions(input),
      championPredictions: []
    };
  }

  if (!isRecord(input)) {
    return EMPTY_PREDICTIONS;
  }

  return {
    matchPredictions: normalizeMatchPredictions(input.matchPredictions),
    championPredictions: normalizeChampionPredictions(input.championPredictions)
  };
}

export function parsePlayerExport(input: unknown): PlayerExport | null {
  if (!isRecord(input)) {
    return null;
  }

  const player = normalizePlayer(input.player);
  const predictions = normalizePredictionsFile(input);

  if (!player || !player.id || !player.name) {
    return null;
  }

  return {
    player,
    matchPredictions: predictions.matchPredictions.map((prediction) => ({
      ...prediction,
      playerId: player.id
    })),
    championPredictions: predictions.championPredictions.map((prediction) => ({
      ...prediction,
      playerId: player.id
    })),
    exportedAt:
      typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString()
  };
}

export function createPlayerExport(
  player: Player,
  predictions: PredictionsFile
): PlayerExport {
  return {
    player,
    matchPredictions: predictions.matchPredictions.map((prediction) => ({
      ...prediction,
      playerId: player.id
    })),
    championPredictions: predictions.championPredictions.map((prediction) => ({
      ...prediction,
      playerId: player.id
    })),
    exportedAt: new Date().toISOString()
  };
}

export function mergePlayerExports(
  exports: PlayerExport[],
  existingPlayers: Player[] = [],
  existingPredictions: PredictionsFile = EMPTY_PREDICTIONS
) {
  const playersById = new Map<string, Player>();
  const matchPredictionsByKey = new Map<string, MatchPrediction>();
  const championPredictionsByKey = new Map<string, ChampionPrediction>();

  for (const player of existingPlayers) {
    playersById.set(player.id, player);
  }

  for (const prediction of existingPredictions.matchPredictions) {
    keepLatest(matchPredictionsByKey, getMatchPredictionKey(prediction), prediction);
  }

  for (const prediction of existingPredictions.championPredictions) {
    keepLatest(championPredictionsByKey, prediction.playerId, prediction);
  }

  for (const playerExport of exports) {
    playersById.set(playerExport.player.id, playerExport.player);

    for (const prediction of playerExport.matchPredictions) {
      keepLatest(matchPredictionsByKey, getMatchPredictionKey(prediction), prediction);
    }

    for (const prediction of playerExport.championPredictions) {
      keepLatest(championPredictionsByKey, prediction.playerId, prediction);
    }
  }

  return {
    players: Array.from(playersById.values()).sort((left, right) =>
      left.name.localeCompare(right.name, "pl")
    ),
    predictions: {
      matchPredictions: Array.from(matchPredictionsByKey.values()).sort(
        sortMatchPredictions
      ),
      championPredictions: Array.from(championPredictionsByKey.values()).sort(
        sortChampionPredictions
      )
    } satisfies PredictionsFile
  };
}

export function validatePredictionTimings(
  predictions: MatchPrediction[],
  matches: Match[]
): ImportWarning[] {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const warnings: ImportWarning[] = [];

  for (const prediction of predictions) {
    const match = matchById.get(prediction.matchId);

    if (!match) {
      warnings.push({
        playerId: prediction.playerId,
        matchId: prediction.matchId,
        message: "Typ wskazuje na mecz, którego nie ma w matches.json."
      });
      continue;
    }

    const updatedAt = Date.parse(prediction.updatedAt);
    const kickoffAt = Date.parse(match.kickoffAt);

    if (
      !Number.isNaN(updatedAt) &&
      !Number.isNaN(kickoffAt) &&
      updatedAt > kickoffAt
    ) {
      warnings.push({
        playerId: prediction.playerId,
        matchId: prediction.matchId,
        message: "Typ został zapisany po czasie rozpoczęcia meczu."
      });
    }
  }

  return warnings;
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}

export function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function normalizeMatchPredictions(input: unknown): MatchPrediction[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    if (
      typeof item.playerId !== "string" ||
      typeof item.matchId !== "string" ||
      typeof item.predictedHomeScore !== "number" ||
      typeof item.predictedAwayScore !== "number" ||
      !Number.isFinite(item.predictedHomeScore) ||
      !Number.isFinite(item.predictedAwayScore)
    ) {
      return [];
    }

    return [
      {
        playerId: item.playerId,
        matchId: item.matchId,
        predictedHomeScore: Math.max(0, Math.trunc(item.predictedHomeScore)),
        predictedAwayScore: Math.max(0, Math.trunc(item.predictedAwayScore)),
        updatedAt:
          typeof item.updatedAt === "string"
            ? item.updatedAt
            : new Date().toISOString()
      }
    ];
  });
}

function normalizeChampionPredictions(input: unknown): ChampionPrediction[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }

    if (
      typeof item.playerId !== "string" ||
      typeof item.championTeamId !== "string"
    ) {
      return [];
    }

    return [
      {
        playerId: item.playerId,
        championTeamId: item.championTeamId,
        updatedAt:
          typeof item.updatedAt === "string"
            ? item.updatedAt
            : new Date().toISOString()
      }
    ];
  });
}

function normalizePlayer(input: unknown): Player | null {
  if (!isRecord(input)) {
    return null;
  }

  if (typeof input.id !== "string" || typeof input.name !== "string") {
    return null;
  }

  return {
    id: input.id.trim(),
    name: input.name.trim()
  };
}

function keepLatest<T extends { updatedAt: string }>(
  map: Map<string, T>,
  key: string,
  next: T
) {
  const current = map.get(key);

  if (!current || getDateValue(next.updatedAt) >= getDateValue(current.updatedAt)) {
    map.set(key, next);
  }
}

function getMatchPredictionKey(prediction: MatchPrediction) {
  return `${prediction.playerId}::${prediction.matchId}`;
}

function sortMatchPredictions(left: MatchPrediction, right: MatchPrediction) {
  return (
    left.playerId.localeCompare(right.playerId, "pl") ||
    left.matchId.localeCompare(right.matchId, "pl")
  );
}

function sortChampionPredictions(
  left: ChampionPrediction,
  right: ChampionPrediction
) {
  return left.playerId.localeCompare(right.playerId, "pl");
}

function getDateValue(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
