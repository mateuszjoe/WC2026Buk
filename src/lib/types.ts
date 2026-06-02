export type Outcome = "home" | "draw" | "away";

export interface Team {
  id: string;
  name: string;
}

export type MatchStatus = "scheduled" | "live" | "finished" | "postponed";

export interface Match {
  id: string;
  stage: string;
  group?: string | null;
  kickoffAt: string;
  homeTeam: Team;
  awayTeam: Team;
  status: MatchStatus;
  // Admin ręcznie aktualizuje status, homeScore i awayScore w public/data/matches.json.
  homeScore: number | null;
  awayScore: number | null;
}

export interface Player {
  id: string;
  name: string;
}

export interface Settings {
  tournamentName: string;
  points: {
    correctResult: number;
    exactScore: number;
    tournamentWinner: number;
  };
  lockPredictionsAtKickoff: boolean;
  championTeamId: string | null;
}

export interface MatchPrediction {
  playerId: string;
  matchId: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  updatedAt: string;
}

export interface ChampionPrediction {
  playerId: string;
  championTeamId: string;
  updatedAt: string;
}

export interface PredictionsFile {
  matchPredictions: MatchPrediction[];
  championPredictions: ChampionPrediction[];
}

export interface PlayerExport {
  player: Player;
  matchPredictions: MatchPrediction[];
  championPredictions: ChampionPrediction[];
  exportedAt: string;
}

export interface MatchScoreResult {
  points: number;
  isExactScore: boolean;
  isCorrectOutcome: boolean;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  playerName: string;
  totalPoints: number;
  matchPoints: number;
  championPoints: number;
  exactScoreCount: number;
  correctOutcomeCount: number;
}

export interface ImportWarning {
  playerId: string;
  matchId: string;
  message: string;
}
