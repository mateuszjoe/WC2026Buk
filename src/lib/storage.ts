import type { Player, PredictionsFile } from "./types";

const PLAYER_KEY = "wc2026buk.player";
const PREDICTIONS_KEY = "wc2026buk.predictions";

const EMPTY_PREDICTIONS: PredictionsFile = {
  matchPredictions: [],
  championPredictions: []
};

export function loadLocalPlayer(): Player | null {
  return readJson<Player>(PLAYER_KEY);
}

export function saveLocalPlayer(player: Player) {
  writeJson(PLAYER_KEY, player);
}

export function loadLocalPredictions(): PredictionsFile {
  return readJson<PredictionsFile>(PREDICTIONS_KEY) ?? EMPTY_PREDICTIONS;
}

export function saveLocalPredictions(predictions: PredictionsFile) {
  writeJson(PREDICTIONS_KEY, predictions);
}

export function clearLocalPredictions() {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.removeItem(PREDICTIONS_KEY);
}

function readJson<T>(key: string): T | null {
  if (!canUseStorage()) {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(key);
    return rawValue ? (JSON.parse(rawValue) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(key, JSON.stringify(value));
}

function canUseStorage() {
  return typeof window !== "undefined" && "localStorage" in window;
}
