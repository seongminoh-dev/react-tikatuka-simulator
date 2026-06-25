import {
  type ApplyResult,
  type Board,
  type BoardSide,
  type Die,
  type DieKind,
  type DieValue,
  type GameAction,
  type GameState,
  type LineIndex,
  type Owner,
  type PlaceNormalAction,
  type PlaceShieldAction,
  type RollMode
} from "./types";

const LINE_INDEXES: LineIndex[] = [0, 1, 2];

let fallbackId = 0;

export function createDie(value: DieValue, kind: DieKind): Die {
  const cryptoId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `die-${Date.now()}-${fallbackId++}`;

  return {
    id: cryptoId,
    value,
    kind
  };
}

export function createEmptyBoard(): Board {
  return {
    player: [[], [], []],
    opponent: [[], [], []]
  };
}

export function createInitialState(): GameState {
  return {
    board: createEmptyBoard(),
    turn: "player",
    playerHeld: false,
    rerollAvailable: true,
    openingShieldOwner: "player",
    pendingBonus: null
  };
}

export function cloneState(state: GameState): GameState {
  return {
    board: {
      player: cloneSide(state.board.player),
      opponent: cloneSide(state.board.opponent)
    },
    turn: state.turn,
    playerHeld: state.playerHeld,
    rerollAvailable: state.rerollAvailable,
    openingShieldOwner: state.openingShieldOwner,
    pendingBonus: state.pendingBonus
  };
}

export function cloneSide(side: BoardSide): BoardSide {
  return [
    side[0].map((die) => ({ ...die })),
    side[1].map((die) => ({ ...die })),
    side[2].map((die) => ({ ...die }))
  ];
}

export function otherOwner(owner: Owner): Owner {
  return owner === "player" ? "opponent" : "player";
}

export function lineIndexes(): LineIndex[] {
  return LINE_INDEXES;
}

export function totalDice(side: BoardSide): number {
  return side.reduce((sum, line) => sum + line.length, 0);
}

export function sideHasSpace(side: BoardSide): boolean {
  return side.some((line) => line.length < 3);
}

export function canAct(state: GameState, owner: Owner): boolean {
  if (owner === "player" && state.playerHeld) {
    return false;
  }

  return totalDice(state.board[owner]) < 9;
}

export function isTerminal(state: GameState): boolean {
  if (state.pendingBonus) {
    return false;
  }

  return !canAct(state, "player") && !canAct(state, "opponent");
}

export function advanceTurn(state: GameState): GameState {
  const next = cloneState(state);

  if (next.pendingBonus) {
    return next;
  }

  const preferred = otherOwner(next.turn);
  if (canAct(next, preferred)) {
    next.turn = preferred;
    return next;
  }

  if (canAct(next, next.turn)) {
    return next;
  }

  next.turn = preferred;
  return next;
}

export function normalPlacementWouldKnock(
  state: GameState,
  actor: Owner,
  value: DieValue,
  lineIndex: LineIndex
): Die[] {
  const targetLine = state.board[otherOwner(actor)][lineIndex];
  return targetLine.filter(
    (die) => die.kind === "normal" && die.value === value
  );
}

export function hasOpeningShield(state: GameState, actor: Owner): boolean {
  return state.openingShieldOwner === actor && totalDice(state.board[actor]) === 0;
}

export function applyPlaceNormal(
  state: GameState,
  action: PlaceNormalAction
): ApplyResult {
  const next = cloneState(state);
  const actorLine = next.board[action.actor][action.lineIndex];

  if (actorLine.length >= 3) {
    throw new Error("Cannot place a die into a full line.");
  }

  const openingShield = hasOpeningShield(next, action.actor);
  if (openingShield) {
    const placedDie = createDie(action.value, "shield");
    actorLine.push(placedDie);
    next.openingShieldOwner = null;

    return {
      state: advanceTurn(next),
      knocked: [],
      placedDie,
      consumedOpeningShield: true
    };
  }

  const defender = otherOwner(action.actor);
  const defenderLine = next.board[defender][action.lineIndex];
  const knocked = defenderLine.filter(
    (die) => die.kind === "normal" && die.value === action.value
  );

  if (knocked.length > 0) {
    next.board[defender][action.lineIndex] = defenderLine.filter(
      (die) => !(die.kind === "normal" && die.value === action.value)
    ) as BoardSide[number];
    next.pendingBonus = action.actor;
    next.turn = action.actor;

    return {
      state: next,
      knocked,
      consumedOpeningShield: false
    };
  }

  const placedDie = createDie(action.value, "normal");
  actorLine.push(placedDie);

  return {
    state: advanceTurn(next),
    knocked: [],
    placedDie,
    consumedOpeningShield: false
  };
}

export function applyPlaceShield(
  state: GameState,
  action: PlaceShieldAction
): ApplyResult {
  const next = cloneState(state);
  const targetLine = next.board[action.targetOwner][action.lineIndex];

  if (targetLine.length >= 3) {
    throw new Error("Cannot place a shield die into a full line.");
  }

  const placedDie = createDie(action.value, "shield");
  targetLine.push(placedDie);

  if (next.pendingBonus === action.actor) {
    next.pendingBonus = null;
  }

  if (action.source === "opening" && next.openingShieldOwner === action.actor) {
    next.openingShieldOwner = null;
  }

  next.turn = action.actor;

  return {
    state: advanceTurn(next),
    knocked: [],
    placedDie,
    consumedOpeningShield: action.source === "opening"
  };
}

export function applyAction(state: GameState, action: GameAction): ApplyResult {
  if (action.type === "place-normal") {
    return applyPlaceNormal(state, action);
  }

  if (action.type === "place-shield") {
    return applyPlaceShield(state, action);
  }

  if (action.type === "hold") {
    const next = cloneState(state);
    next.playerHeld = true;
    next.pendingBonus = null;
    next.turn = "player";

    return {
      state: advanceTurn(next),
      knocked: [],
      consumedOpeningShield: false
    };
  }

  if (action.type === "reroll") {
    const next = cloneState(state);
    next.rerollAvailable = false;

    return {
      state: next,
      knocked: [],
      consumedOpeningShield: false
    };
  }

  throw new Error("Unsupported action.");
}

export function legalActionsForRoll(
  state: GameState,
  actor: Owner,
  rollValue: DieValue,
  rollMode: RollMode,
  alternateRollValue: DieValue | null = null,
  includeReroll = true
): GameAction[] {
  const values = alternateRollValue
    ? [
        { value: rollValue, usesAlternate: false },
        { value: alternateRollValue, usesAlternate: true }
      ]
    : [{ value: rollValue, usesAlternate: false }];
  const actions: GameAction[] = [];
  const isBonus = state.pendingBonus === actor || rollMode === "shield";
  const isOpening = hasOpeningShield(state, actor) && !isBonus;

  for (const choice of values) {
    if (isBonus) {
      for (const owner of ["player", "opponent"] as Owner[]) {
        for (const lineIndex of LINE_INDEXES) {
          if (state.board[owner][lineIndex].length < 3) {
            actions.push({
              type: "place-shield",
              actor,
              value: choice.value,
              targetOwner: owner,
              lineIndex,
              source: "bonus",
              usesAlternate: choice.usesAlternate
            });
          }
        }
      }
      continue;
    }

    if (isOpening) {
      for (const lineIndex of LINE_INDEXES) {
        if (state.board[actor][lineIndex].length < 3) {
          actions.push({
            type: "place-shield",
            actor,
            value: choice.value,
            targetOwner: actor,
            lineIndex,
            source: "opening",
            usesAlternate: choice.usesAlternate
          });
        }
      }
      continue;
    }

    for (const lineIndex of LINE_INDEXES) {
      if (state.board[actor][lineIndex].length < 3) {
        actions.push({
          type: "place-normal",
          actor,
          value: choice.value,
          lineIndex,
          usesAlternate: choice.usesAlternate
        });
      }
    }
  }

  if (
    actor === "player" &&
    rollMode === "normal" &&
    !alternateRollValue &&
    state.rerollAvailable &&
    includeReroll &&
    !state.pendingBonus
  ) {
    actions.push({
      type: "reroll",
      actor: "player",
      value: rollValue
    });
  }

  if (actor === "player" && rollMode === "normal" && !state.pendingBonus) {
    actions.push({
      type: "hold",
      actor: "player"
    });
  }

  return actions;
}

export function removeDieAt(
  state: GameState,
  owner: Owner,
  lineIndex: LineIndex,
  dieId: string
): GameState {
  const next = cloneState(state);
  next.board[owner][lineIndex] = next.board[owner][lineIndex].filter(
    (die) => die.id !== dieId
  ) as BoardSide[number];
  return next;
}

export function addManualDie(
  state: GameState,
  owner: Owner,
  lineIndex: LineIndex,
  value: DieValue,
  kind: DieKind
): GameState {
  const next = cloneState(state);
  if (next.board[owner][lineIndex].length >= 3) {
    return next;
  }

  next.board[owner][lineIndex].push(createDie(value, kind));
  return next;
}

export function actionKey(action: GameAction): string {
  if (action.type === "place-normal") {
    return [
      action.type,
      action.actor,
      action.value,
      action.lineIndex,
      action.usesAlternate ? "alt" : "main"
    ].join(":");
  }

  if (action.type === "place-shield") {
    return [
      action.type,
      action.actor,
      action.value,
      action.targetOwner,
      action.lineIndex,
      action.source,
      action.usesAlternate ? "alt" : "main"
    ].join(":");
  }

  if (action.type === "hold") {
    return "hold:player";
  }

  return `reroll:player:${action.value}`;
}

export function formatAction(action: GameAction): string {
  if (action.type === "hold") {
    return "홀드";
  }

  if (action.type === "reroll") {
    return `${action.value} 리롤 사용`;
  }

  const actor = action.actor === "player" ? "나" : "상대";
  const line = `${action.lineIndex + 1}번 라인`;
  const alt = action.usesAlternate ? "리롤값 " : "";

  if (action.type === "place-normal") {
    return `${actor} ${line}에 ${alt}일반 ${action.value}`;
  }

  const target = action.targetOwner === "player" ? "내" : "상대";
  const source = action.source === "bonus" ? "보너스 쉴드" : "쉴드";
  return `${target} ${line}에 ${alt}${source} ${action.value}`;
}
