import { evaluateBoard, scoreLine } from "./scoring";
import {
  applyAction,
  cloneState,
  formatAction,
  legalActionsForRoll,
  normalPlacementWouldKnock,
  otherOwner
} from "./rules";
import type {
  AiProfileName,
  DieValue,
  GameAction,
  GameState,
  LineIndex,
  Owner,
  RollMode
} from "./types";

interface PolicyWeights {
  knock: number;
  removedPoint: number;
  ownScoreGain: number;
  targetScoreLoss: number;
  blockLine: number;
  lowBonusToEnemy: number;
  highBonusToSelf: number;
  shieldSafety: number;
  lineWin: number;
  totalScore: number;
  randomJitter: number;
}

export const AI_PROFILES: Record<AiProfileName, PolicyWeights> = {
  observed: {
    knock: 950,
    removedPoint: 16,
    ownScoreGain: 5,
    targetScoreLoss: 7,
    blockLine: 90,
    lowBonusToEnemy: 85,
    highBonusToSelf: 70,
    shieldSafety: 24,
    lineWin: 120,
    totalScore: 2.4,
    randomJitter: 2
  },
  aggressive: {
    knock: 1200,
    removedPoint: 22,
    ownScoreGain: 4,
    targetScoreLoss: 10,
    blockLine: 40,
    lowBonusToEnemy: 55,
    highBonusToSelf: 45,
    shieldSafety: 12,
    lineWin: 90,
    totalScore: 2,
    randomJitter: 3
  },
  score: {
    knock: 520,
    removedPoint: 8,
    ownScoreGain: 15,
    targetScoreLoss: 5,
    blockLine: 24,
    lowBonusToEnemy: 20,
    highBonusToSelf: 95,
    shieldSafety: 20,
    lineWin: 150,
    totalScore: 5,
    randomJitter: 1
  },
  blocker: {
    knock: 820,
    removedPoint: 13,
    ownScoreGain: 4,
    targetScoreLoss: 8,
    blockLine: 160,
    lowBonusToEnemy: 150,
    highBonusToSelf: 35,
    shieldSafety: 18,
    lineWin: 115,
    totalScore: 1.8,
    randomJitter: 2
  }
};

export function utilityForPlayer(state: GameState): number {
  const outcome = evaluateBoard(state.board);
  const lineDelta = outcome.playerLineWins - outcome.opponentLineWins;
  const totalDelta = outcome.playerTotal - outcome.opponentTotal;
  const playerShieldCount = state.board.player
    .flat()
    .filter((die) => die.kind === "shield").length;
  const opponentShieldCount = state.board.opponent
    .flat()
    .filter((die) => die.kind === "shield").length;
  const playerOpenSlots = 9 - state.board.player.flat().length;
  const opponentOpenSlots = 9 - state.board.opponent.flat().length;

  return (
    lineDelta * 90 +
    totalDelta * 4 +
    (playerShieldCount - opponentShieldCount) * 5 +
    (opponentOpenSlots - playerOpenSlots) * 1.5
  );
}

export function scoreActionForActor(
  state: GameState,
  action: GameAction,
  actor: Owner,
  aiProfile: AiProfileName
): number {
  if (actor === "player") {
    return scorePlayerAction(state, action);
  }

  return scoreOpponentAction(state, action, aiProfile);
}

function scorePlayerAction(state: GameState, action: GameAction): number {
  if (action.type === "reroll") {
    return estimatePlayerRerollValue(state, action.value);
  }

  try {
    const before = utilityForPlayer(state);
    const result = applyAction(state, action);
    const after = utilityForPlayer(result.state);
    const knockBonus = result.knocked.length * 80;
    return after - before + knockBonus;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function estimatePlayerRerollValue(state: GameState, currentValue: DieValue): number {
  const base = bestPlayerPlacementScore(state, currentValue, null);
  let rerollTotal = 0;
  let rerollCases = 0;

  for (let value = 1; value <= 6; value += 1) {
    if (value === currentValue) {
      continue;
    }

    rerollCases += 1;
    rerollTotal += bestPlayerPlacementScore(
      {
        ...state,
        rerollAvailable: false
      },
      currentValue,
      value as DieValue
    );
  }

  return rerollTotal / rerollCases - base - 4;
}

function bestPlayerPlacementScore(
  state: GameState,
  value: DieValue,
  alternateValue: DieValue | null
): number {
  const actions = legalActionsForRoll(
    state,
    "player",
    value,
    "normal",
    alternateValue,
    false
  ).filter((action) => action.type !== "hold");

  if (actions.length === 0) {
    return -999;
  }

  return Math.max(...actions.map((action) => scorePlayerAction(state, action)));
}

function scoreOpponentAction(
  state: GameState,
  action: GameAction,
  aiProfile: AiProfileName
): number {
  const weights = AI_PROFILES[aiProfile];

  if (action.type === "hold" || action.type === "reroll") {
    return Number.NEGATIVE_INFINITY;
  }

  if (action.type === "place-normal") {
    const knocked = normalPlacementWouldKnock(
      state,
      "opponent",
      action.value,
      action.lineIndex
    );
    const ownBefore = scoreLine(state.board.opponent[action.lineIndex]);
    const targetBefore = scoreLine(state.board.player[action.lineIndex]);

    let after: GameState;
    try {
      after = applyAction(state, action).state;
    } catch {
      return Number.NEGATIVE_INFINITY;
    }

    const ownAfter = scoreLine(after.board.opponent[action.lineIndex]);
    const targetAfter = scoreLine(after.board.player[action.lineIndex]);
    const outcome = evaluateBoard(after.board);
    const removedPoints = knocked.reduce((sum, die) => sum + die.value, 0);

    return (
      knocked.length * weights.knock +
      removedPoints * weights.removedPoint +
      Math.max(0, ownAfter - ownBefore) * weights.ownScoreGain +
      Math.max(0, targetBefore - targetAfter) * weights.targetScoreLoss +
      (outcome.opponentLineWins - outcome.playerLineWins) * weights.lineWin +
      (outcome.opponentTotal - outcome.playerTotal) * weights.totalScore
    );
  }

  const targetLineBefore = state.board[action.targetOwner][action.lineIndex];
  const targetBefore = scoreLine(targetLineBefore);
  const beforeOutcome = evaluateBoard(state.board);
  let after: GameState;
  try {
    after = applyAction(state, action).state;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }

  const targetAfter = scoreLine(after.board[action.targetOwner][action.lineIndex]);
  const targetIsEnemy = action.targetOwner === "player";
  const lineFilled = after.board[action.targetOwner][action.lineIndex].length === 3;
  const lowBonus = action.value <= 2;
  const highBonus = action.value >= 4;
  const outcome = evaluateBoard(after.board);
  const scoreGift = Math.max(0, targetAfter - targetBefore);
  const lineSwing =
    outcome.opponentLineWins -
    outcome.playerLineWins -
    (beforeOutcome.opponentLineWins - beforeOutcome.playerLineWins);
  const totalSwing =
    outcome.opponentTotal -
    outcome.playerTotal -
    (beforeOutcome.opponentTotal - beforeOutcome.playerTotal);

  if (targetIsEnemy) {
    const slotPressure = targetLineBefore.length + 1;
    const lowValueBlock =
      lowBonus ? weights.lowBonusToEnemy + targetBefore * 8 + slotPressure * 18 : 0;

    return (
      Math.max(0, targetBefore - targetAfter) * weights.targetScoreLoss +
      lowValueBlock +
      (lineFilled ? weights.blockLine : 0) -
      scoreGift * (lowBonus ? 6 : 11) -
      (highBonus ? action.value * 14 : 0) +
      lineSwing * weights.lineWin * 0.45 +
      totalSwing * weights.totalScore
    );
  }

  return (
    Math.max(0, targetAfter - targetBefore) * weights.ownScoreGain +
    (highBonus ? weights.highBonusToSelf : 0) +
    (action.value >= 3 ? weights.shieldSafety : 0) -
    (lowBonus ? weights.lowBonusToEnemy * 0.85 : 0) -
    (lowBonus && targetLineBefore.length === 0 ? 30 : 0) +
    lineSwing * weights.lineWin * 0.45 +
    totalSwing * weights.totalScore
  );
}

export function choosePolicyAction(
  state: GameState,
  actor: Owner,
  rollValue: DieValue,
  rollMode: RollMode,
  aiProfile: AiProfileName,
  rng: () => number,
  alternateRollValue: DieValue | null = null
): GameAction | null {
  const actions = legalActionsForRoll(
    state,
    actor,
    rollValue,
    rollMode,
    alternateRollValue,
    actor === "player"
  );

  if (actions.length === 0) {
    return null;
  }

  let bestAction = actions[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  const jitter = actor === "opponent" ? AI_PROFILES[aiProfile].randomJitter : 0.5;

  for (const action of actions) {
    const score =
      scoreActionForActor(state, action, actor, aiProfile) + rng() * jitter;
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  return bestAction;
}

export function chooseBestConcretePlayerAction(
  state: GameState,
  currentValue: DieValue,
  alternateValue: DieValue | null,
  rollMode: RollMode,
  aiProfile: AiProfileName,
  rng: () => number
): GameAction | null {
  const actions = legalActionsForRoll(
    state,
    "player",
    currentValue,
    rollMode,
    alternateValue,
    false
  );

  let bestAction: GameAction | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const action of actions) {
    const score =
      scoreActionForActor(state, action, "player", aiProfile) + rng() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      bestAction = action;
    }
  }

  return bestAction;
}

export function describeActionReason(
  state: GameState,
  action: GameAction,
  aiProfile: AiProfileName
): string {
  const label = formatAction(action);

  if (action.type === "place-normal") {
    const knocked = normalPlacementWouldKnock(
      state,
      action.actor,
      action.value,
      action.lineIndex
    );
    if (knocked.length > 0) {
      return `${label}: 알까기 ${knocked.length}개`;
    }
  }

  const score = scoreActionForActor(state, action, action.actor, aiProfile);
  return `${label}: 휴리스틱 ${score.toFixed(1)}`;
}

export function linePressure(state: GameState, owner: Owner, lineIndex: LineIndex): number {
  const enemy = otherOwner(owner);
  return scoreLine(state.board[owner][lineIndex]) - scoreLine(state.board[enemy][lineIndex]);
}

export function stateAfterActionOrClone(
  state: GameState,
  action: GameAction
): GameState {
  try {
    return applyAction(state, action).state;
  } catch {
    return cloneState(state);
  }
}
