import type {
  ChampionPrediction,
  LeaderboardRow,
  Match,
  MatchPrediction,
  MatchScoreResult,
  Outcome,
  Player,
  PredictionsFile,
  Settings
} from "./types";

const EMPTY_MATCH_SCORE: MatchScoreResult = {
  points: 0,
  isExactScore: false,
  isCorrectOutcome: false
};

export function getOutcome(
  homeScore: number | null | undefined,
  awayScore: number | null | undefined
): Outcome | null {
  if (
    typeof homeScore !== "number" ||
    typeof awayScore !== "number" ||
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore)
  ) {
    return null;
  }

  if (homeScore > awayScore) {
    return "home";
  }

  if (homeScore < awayScore) {
    return "away";
  }

  return "draw";
}

export function scoreMatchPrediction(
  prediction: MatchPrediction | undefined,
  match: Match | undefined,
  settings: Settings
): MatchScoreResult {
  if (!prediction || !match) {
    return EMPTY_MATCH_SCORE;
  }

  const actualOutcome = getOutcome(match.homeScore, match.awayScore);
  const predictedOutcome = getOutcome(
    prediction.predictedHomeScore,
    prediction.predictedAwayScore
  );

  if (!actualOutcome || !predictedOutcome) {
    return EMPTY_MATCH_SCORE;
  }

  const isExactScore =
    prediction.predictedHomeScore === match.homeScore &&
    prediction.predictedAwayScore === match.awayScore;

  if (isExactScore) {
    return {
      points: settings.points.exactScore,
      isExactScore: true,
      isCorrectOutcome: true
    };
  }

  const isCorrectOutcome = predictedOutcome === actualOutcome;

  return {
    points: isCorrectOutcome ? settings.points.correctResult : 0,
    isExactScore: false,
    isCorrectOutcome
  };
}

export function scoreChampionPrediction(
  prediction: ChampionPrediction | undefined,
  settings: Settings
): number {
  if (!prediction || !settings.championTeamId) {
    return 0;
  }

  return prediction.championTeamId === settings.championTeamId
    ? settings.points.tournamentWinner
    : 0;
}

export function calculateLeaderboard(
  players: Player[],
  matches: Match[],
  predictions: PredictionsFile,
  settings: Settings
): LeaderboardRow[] {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  const playerById = new Map(players.map((player) => [player.id, player]));
  const playerIds = new Set(players.map((player) => player.id));

  for (const prediction of predictions.matchPredictions) {
    playerIds.add(prediction.playerId);
    if (!playerById.has(prediction.playerId)) {
      playerById.set(prediction.playerId, {
        id: prediction.playerId,
        name: prediction.playerId
      });
    }
  }

  for (const prediction of predictions.championPredictions) {
    playerIds.add(prediction.playerId);
    if (!playerById.has(prediction.playerId)) {
      playerById.set(prediction.playerId, {
        id: prediction.playerId,
        name: prediction.playerId
      });
    }
  }

  const latestMatchPredictions = new Map<string, MatchPrediction>();
  for (const prediction of predictions.matchPredictions) {
    keepLatest(
      latestMatchPredictions,
      `${prediction.playerId}::${prediction.matchId}`,
      prediction
    );
  }

  const latestChampionPredictions = new Map<string, ChampionPrediction>();
  for (const prediction of predictions.championPredictions) {
    keepLatest(latestChampionPredictions, prediction.playerId, prediction);
  }

  const rows = Array.from(playerIds).map((playerId) => {
    const player = playerById.get(playerId);
    let matchPoints = 0;
    let exactScoreCount = 0;
    let correctOutcomeCount = 0;

    for (const match of matches) {
      const prediction = latestMatchPredictions.get(`${playerId}::${match.id}`);
      const score = scoreMatchPrediction(prediction, matchById.get(match.id), settings);

      matchPoints += score.points;
      if (score.isExactScore) {
        exactScoreCount += 1;
      }
      if (score.isCorrectOutcome) {
        correctOutcomeCount += 1;
      }
    }

    const championPoints = scoreChampionPrediction(
      latestChampionPredictions.get(playerId),
      settings
    );

    return {
      rank: 0,
      playerId,
      playerName: player?.name ?? playerId,
      totalPoints: matchPoints + championPoints,
      matchPoints,
      championPoints,
      exactScoreCount,
      correctOutcomeCount
    };
  });

  return rows
    .sort((left, right) => {
      if (right.totalPoints !== left.totalPoints) {
        return right.totalPoints - left.totalPoints;
      }
      if (right.exactScoreCount !== left.exactScoreCount) {
        return right.exactScoreCount - left.exactScoreCount;
      }
      if (right.correctOutcomeCount !== left.correctOutcomeCount) {
        return right.correctOutcomeCount - left.correctOutcomeCount;
      }
      return left.playerName.localeCompare(right.playerName, "pl");
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1
    }));
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

function getDateValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
