import { evaluateBoard } from "./scoring";
import {
  advanceTurn,
  applyAction,
  canAct,
  cloneState,
  isTerminal,
  legalActionsForRoll
} from "./rules";
import {
  chooseBestConcretePlayerAction,
  choosePolicyAction
} from "./policies";
import { rollDie, rollDifferentDie } from "./random";
import type {
  AiProfileName,
  DieValue,
  GameAction,
  GameOutcome,
  GameState,
  RollMode
} from "./types";

const MAX_PLAYOUT_STEPS = 160;

export function simulatePlayout(
  startState: GameState,
  aiProfile: AiProfileName,
  rng: () => number
): GameOutcome {
  let state = cloneState(startState);

  for (let step = 0; step < MAX_PLAYOUT_STEPS; step += 1) {
    if (isTerminal(state)) {
      return evaluateBoard(state.board);
    }

    if (state.pendingBonus) {
      const actor = state.pendingBonus;
      const bonusValue = rollDie(rng);
      const action = choosePolicyAction(
        state,
        actor,
        bonusValue,
        "shield",
        aiProfile,
        rng
      );

      if (!action) {
        state.pendingBonus = null;
        state = advanceTurn(state);
        continue;
      }

      state = applyAction(state, action).state;
      continue;
    }

    const actor = state.turn;

    if (!canAct(state, actor)) {
      state = advanceTurn(state);
      continue;
    }

    const rollValue = rollDie(rng);
    const action = chooseTurnAction(state, rollValue, aiProfile, rng);

    if (!action) {
      state = advanceTurn(state);
      continue;
    }

    if (action.type === "reroll") {
      const secondValue = rollDifferentDie(rng, rollValue);
      const rerolledState = applyAction(state, action).state;
      const concrete = chooseBestConcretePlayerAction(
        rerolledState,
        rollValue,
        secondValue,
        "normal",
        aiProfile,
        rng
      );
      state = concrete ? applyAction(rerolledState, concrete).state : rerolledState;
      continue;
    }

    state = applyAction(state, action).state;
  }

  return evaluateBoard(state.board);
}

function chooseTurnAction(
  state: GameState,
  rollValue: DieValue,
  aiProfile: AiProfileName,
  rng: () => number
): GameAction | null {
  const actor = state.turn;

  return choosePolicyAction(state, actor, rollValue, "normal", aiProfile, rng);
}

export function applyRootActionForSimulation(
  state: GameState,
  action: GameAction,
  rng: () => number,
  aiProfile: AiProfileName
): GameState {
  if (action.type !== "reroll") {
    return applyAction(state, action).state;
  }

  const rerolledState = applyAction(state, action).state;
  const secondValue = rollDifferentDie(rng, action.value);
  const concrete = chooseBestConcretePlayerAction(
    rerolledState,
    action.value,
    secondValue,
    "normal",
    aiProfile,
    rng
  );

  return concrete ? applyAction(rerolledState, concrete).state : rerolledState;
}

export function concreteActionsForRoot(
  state: GameState,
  actor: "player" | "opponent",
  rollValue: DieValue,
  rollMode: RollMode,
  alternateRollValue: DieValue | null
): GameAction[] {
  return legalActionsForRoll(
    state,
    actor,
    rollValue,
    rollMode,
    alternateRollValue,
    true
  );
}
