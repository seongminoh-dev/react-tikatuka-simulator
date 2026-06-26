import {
  AI_PROFILES,
  normalizePolicyWeights,
  scoreActionForActor
} from "./policies";
import { actionKey, formatAction, normalPlacementWouldKnock } from "./rules";
import type {
  AiFitDiagnostics,
  AiMismatchLog,
  GameAction,
  GameState,
  LearnedAiModel,
  LineIndex,
  ObservationEntry,
  PolicyWeights
} from "./types";

const POSITIVE_TUNABLE_KEYS: Array<keyof PolicyWeights> = [
  "knock",
  "removedPoint",
  "ownScoreGain",
  "targetScoreLoss",
  "blockLine",
  "lowBonusToEnemy",
  "highBonusToSelf",
  "shieldSafety",
  "lineWin",
  "totalScore"
];

const BIAS_TUNABLE_KEYS: Array<keyof PolicyWeights> = [
  "line1Bias",
  "line2Bias",
  "line3Bias",
  "bonusToEnemyBias",
  "bonusToSelfBias"
];

const FACTORS = [0.65, 0.8, 0.9, 1.1, 1.25, 1.5];
const BIAS_STEPS = [120, 60, 30, 15];
const NEAR_TOP_SCORE_GAP = 12;
const SUSPICIOUS_KNOCK_GAP = 240;

export function createInitialLearnedModel(): LearnedAiModel {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    weights: { ...AI_PROFILES.observed },
    diagnostics: evaluateAiFit([], AI_PROFILES.observed),
    updateLog: []
  };
}

export function tuneLearnedAiModel(
  observations: ObservationEntry[],
  previousModel: LearnedAiModel | null
): LearnedAiModel {
  const usable = observations
    .filter((entry) => entry.action.actor === "opponent")
    .slice(0, 250);
  const baseWeights = normalizePolicyWeights(previousModel?.weights);
  let bestWeights = { ...baseWeights };
  let bestDiagnostics = evaluateAiFit(usable, bestWeights);
  let bestObjective = objective(bestDiagnostics);

  if (usable.length >= 6) {
    for (let pass = 0; pass < 5; pass += 1) {
      let improved = false;

      for (const key of POSITIVE_TUNABLE_KEYS) {
        for (const factor of FACTORS) {
          const candidate = {
            ...bestWeights,
            [key]: clampPositiveWeight(bestWeights[key] * factor)
          };
          const diagnostics = evaluateAiFit(usable, candidate);
          const score = objective(diagnostics);

          if (score > bestObjective + 0.0001) {
            bestWeights = candidate;
            bestDiagnostics = diagnostics;
            bestObjective = score;
            improved = true;
          }
        }
      }

      const step = BIAS_STEPS[Math.min(pass, BIAS_STEPS.length - 1)];
      for (const key of BIAS_TUNABLE_KEYS) {
        for (const delta of [-step, step]) {
          const candidate = {
            ...bestWeights,
            [key]: clampBias(bestWeights[key] + delta)
          };
          const diagnostics = evaluateAiFit(usable, candidate);
          const score = objective(diagnostics);

          if (score > bestObjective + 0.0001) {
            bestWeights = candidate;
            bestDiagnostics = diagnostics;
            bestObjective = score;
            improved = true;
          }
        }
      }

      if (!improved) {
        break;
      }
    }
  }

  const now = new Date().toISOString();
  const updateLog = [
    {
      id: `fit-${now}-${Math.random().toString(16).slice(2)}`,
      createdAt: now,
      observationCount: bestDiagnostics.observationCount,
      accuracy: bestDiagnostics.accuracy,
      nearTopAccuracy: bestDiagnostics.nearTopAccuracy,
      top3Accuracy: bestDiagnostics.top3Accuracy,
      averageActualRank: bestDiagnostics.averageActualRank,
      ignoredObservationCount: bestDiagnostics.ignoredObservationCount
    },
    ...(previousModel?.updateLog ?? [])
  ].slice(0, 120);

  return {
    version: (previousModel?.version ?? 0) + 1,
    updatedAt: now,
    weights: bestWeights,
    diagnostics: bestDiagnostics,
    updateLog
  };
}

export function evaluateAiFit(
  observations: ObservationEntry[],
  weights: PolicyWeights
): AiFitDiagnostics {
  const normalizedWeights = normalizePolicyWeights(weights);
  let totalObservations = 0;
  let ignored = 0;
  let counted = 0;
  let top1 = 0;
  let nearTop = 0;
  let top3 = 0;
  let rankTotal = 0;
  const mismatches: AiMismatchLog[] = [];

  for (const entry of observations) {
    const actualKey = actionKey(entry.action);
    const candidates = entry.legalActions
      .filter(
        (action) =>
          action.actor === "opponent" &&
          (action.type === "place-normal" || action.type === "place-shield")
      )
      .map((action) =>
        scoreCandidate(entry.stateBefore, action, normalizedWeights)
      )
      .sort((a, b) => b.score - a.score);

    const rank = candidates.findIndex((candidate) => actionKey(candidate.action) === actualKey);

    if (rank < 0 || candidates.length === 0) {
      continue;
    }

    totalObservations += 1;
    const actual = candidates[rank];
    const predicted = candidates[0];
    const scoreGap = Math.max(0, predicted.score - actual.score);
    const suspicious = isSuspiciousKnockMiss(actual, candidates);

    if (suspicious) {
      ignored += 1;
      if (mismatches.length < 40) {
        mismatches.push(createMismatchLog(entry, actual, predicted, rank, true));
      }
      continue;
    }

    counted += 1;
    rankTotal += rank + 1;

    if (rank === 0) {
      top1 += 1;
    }

    if (scoreGap <= NEAR_TOP_SCORE_GAP) {
      nearTop += 1;
    }

    if (rank <= 2) {
      top3 += 1;
    }

    if (rank > 0 && mismatches.length < 40) {
      mismatches.push(createMismatchLog(entry, actual, predicted, rank, false));
    }
  }

  return {
    totalObservationCount: totalObservations,
    observationCount: counted,
    ignoredObservationCount: ignored,
    accuracy: counted > 0 ? top1 / counted : 0,
    nearTopAccuracy: counted > 0 ? nearTop / counted : 0,
    top3Accuracy: counted > 0 ? top3 / counted : 0,
    averageActualRank: counted > 0 ? rankTotal / counted : 0,
    mismatches
  };
}

function objective(diagnostics: AiFitDiagnostics): number {
  return (
    diagnostics.accuracy * 1000 +
    diagnostics.nearTopAccuracy * 260 +
    diagnostics.top3Accuracy * 160 -
    diagnostics.averageActualRank * 18 -
    diagnostics.ignoredObservationCount * 2
  );
}

function clampPositiveWeight(value: number): number {
  return Math.min(2500, Math.max(0.05, value));
}

function clampBias(value: number): number {
  return Math.min(240, Math.max(-240, value));
}

interface ScoredCandidate {
  action: GameAction;
  score: number;
  knockCount: number;
}

function scoreCandidate(
  state: GameState,
  action: GameAction,
  weights: PolicyWeights
): ScoredCandidate {
  return {
    action,
    score: scoreActionForActor(state, action, "opponent", "observed", weights),
    knockCount: knockCountForAction(state, action)
  };
}

function knockCountForAction(state: GameState, action: GameAction): number {
  if (action.type !== "place-normal") {
    return 0;
  }

  return normalPlacementWouldKnock(
    state,
    action.actor,
    action.value,
    action.lineIndex
  ).length;
}

function isSuspiciousKnockMiss(
  actual: ScoredCandidate,
  candidates: ScoredCandidate[]
): boolean {
  if (actual.knockCount > 0) {
    return false;
  }

  const bestKnock = candidates.find((candidate) => candidate.knockCount > 0);
  if (!bestKnock) {
    return false;
  }

  return bestKnock.score - actual.score >= SUSPICIOUS_KNOCK_GAP;
}

function createMismatchLog(
  entry: ObservationEntry,
  actual: ScoredCandidate,
  predicted: ScoredCandidate,
  rank: number,
  suspicious: boolean
): AiMismatchLog {
  const scoreGap = Math.max(0, predicted.score - actual.score);

  return {
    id: entry.id,
    createdAt: entry.committedAt ?? entry.createdAt,
    rollValue: entry.rollValue,
    actual: formatAction(entry.action),
    predicted: formatAction(predicted.action),
    actualScore: actual.score,
    predictedScore: predicted.score,
    actualRank: rank + 1,
    scoreGap,
    category: categorizeMismatch(entry.stateBefore, actual, predicted, scoreGap, suspicious),
    suspicious,
    gameResult: entry.gameResult
  };
}

function categorizeMismatch(
  state: GameState,
  actual: ScoredCandidate,
  predicted: ScoredCandidate,
  scoreGap: number,
  suspicious: boolean
): string {
  if (suspicious) {
    return "알까기 기록 의심";
  }

  if (scoreGap <= 0.001) {
    return "동점 타이브레이크";
  }

  if (scoreGap <= NEAR_TOP_SCORE_GAP) {
    return "근접 선택";
  }

  if (actual.action.type !== predicted.action.type) {
    return "행동 타입";
  }

  if (actual.knockCount !== predicted.knockCount) {
    return "알까기 우선순위";
  }

  if (
    actual.action.type === "place-shield" &&
    predicted.action.type === "place-shield" &&
    actual.action.targetOwner !== predicted.action.targetOwner
  ) {
    return "보너스 대상";
  }

  if (
    "lineIndex" in actual.action &&
    "lineIndex" in predicted.action &&
    actual.action.lineIndex !== predicted.action.lineIndex
  ) {
    return lineCategory(state, actual.action.lineIndex, predicted.action.lineIndex);
  }

  return "기타";
}

function lineCategory(
  state: GameState,
  actualLine: LineIndex,
  predictedLine: LineIndex
): string {
  const actualSlots =
    state.board.player[actualLine].length + state.board.opponent[actualLine].length;
  const predictedSlots =
    state.board.player[predictedLine].length +
    state.board.opponent[predictedLine].length;

  if (actualSlots !== predictedSlots) {
    return "라인 채움 선호";
  }

  return "라인 선호";
}
