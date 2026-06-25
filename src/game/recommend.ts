import { formatAction } from "./rules";
import { createRng } from "./random";
import {
  applyRootActionForSimulation,
  concreteActionsForRoot,
  simulatePlayout
} from "./simulate";
import type {
  GameAction,
  GameState,
  Recommendation,
  RecommendationInput
} from "./types";

export function recommendActions(input: RecommendationInput): Recommendation[] {
  const actions = concreteActionsForRoot(
    input.state,
    input.actor,
    input.rollValue,
    input.rollMode,
    input.alternateRollValue
  );

  return actions
    .map((action, index) =>
      evaluateAction(input.state, action, input, input.seed + index * 1009)
    )
    .sort((a, b) => b.winRate - a.winRate || b.averageScoreDiff - a.averageScoreDiff);
}

function evaluateAction(
  state: GameState,
  action: GameAction,
  input: RecommendationInput,
  seed: number
): Recommendation {
  const rng = createRng(seed);
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let scoreDiff = 0;

  for (let sample = 0; sample < input.samplesPerAction; sample += 1) {
    const afterRoot = applyRootActionForSimulation(
      state,
      action,
      rng,
      input.aiProfile
    );
    const outcome = simulatePlayout(afterRoot, input.aiProfile, rng);
    scoreDiff += outcome.playerTotal - outcome.opponentTotal;

    if (outcome.winner === "player") {
      wins += 1;
    } else if (outcome.winner === "opponent") {
      losses += 1;
    } else {
      draws += 1;
    }
  }

  const samples = Math.max(1, input.samplesPerAction);

  return {
    action,
    label: formatAction(action),
    wins,
    losses,
    draws,
    averageScoreDiff: scoreDiff / samples,
    winRate: wins / samples,
    drawRate: draws / samples,
    lossRate: losses / samples,
    samples
  };
}
