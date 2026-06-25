import { AI_PROFILES, scoreActionForActor } from "./policies";
import { actionKey, formatAction } from "./rules";
import type {
  AiFitDiagnostics,
  AiMismatchLog,
  LearnedAiModel,
  ObservationEntry,
  PolicyWeights
} from "./types";

const TUNABLE_KEYS: Array<keyof Omit<PolicyWeights, "randomJitter">> = [
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

const FACTORS = [0.75, 0.9, 1.1, 1.25];

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
  const baseWeights = previousModel?.weights ?? AI_PROFILES.observed;
  let bestWeights = { ...baseWeights };
  let bestDiagnostics = evaluateAiFit(usable, bestWeights);
  let bestObjective = objective(bestDiagnostics);

  if (usable.length >= 6) {
    for (let pass = 0; pass < 4; pass += 1) {
      let improved = false;

      for (const key of TUNABLE_KEYS) {
        for (const factor of FACTORS) {
          const candidate = {
            ...bestWeights,
            [key]: clampWeight(bestWeights[key] * factor)
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
      top3Accuracy: bestDiagnostics.top3Accuracy,
      averageActualRank: bestDiagnostics.averageActualRank
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
  let counted = 0;
  let top1 = 0;
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
      .map((action) => ({
        action,
        score: scoreActionForActor(
          entry.stateBefore,
          action,
          "opponent",
          "observed",
          weights
        )
      }))
      .sort((a, b) => b.score - a.score);

    const rank = candidates.findIndex((candidate) => actionKey(candidate.action) === actualKey);

    if (rank < 0 || candidates.length === 0) {
      continue;
    }

    counted += 1;
    rankTotal += rank + 1;

    if (rank === 0) {
      top1 += 1;
    }

    if (rank <= 2) {
      top3 += 1;
    }

    if (rank > 0 && mismatches.length < 40) {
      const actual = candidates[rank];
      const predicted = candidates[0];
      mismatches.push({
        id: entry.id,
        createdAt: entry.committedAt ?? entry.createdAt,
        rollValue: entry.rollValue,
        actual: formatAction(entry.action),
        predicted: formatAction(predicted.action),
        actualScore: actual.score,
        predictedScore: predicted.score,
        gameResult: entry.gameResult
      });
    }
  }

  return {
    observationCount: counted,
    accuracy: counted > 0 ? top1 / counted : 0,
    top3Accuracy: counted > 0 ? top3 / counted : 0,
    averageActualRank: counted > 0 ? rankTotal / counted : 0,
    mismatches
  };
}

function objective(diagnostics: AiFitDiagnostics): number {
  return (
    diagnostics.accuracy * 1000 +
    diagnostics.top3Accuracy * 160 -
    diagnostics.averageActualRank * 18
  );
}

function clampWeight(value: number): number {
  return Math.min(2500, Math.max(0.05, value));
}
