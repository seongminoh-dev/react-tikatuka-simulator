export type Owner = "player" | "opponent";

export type DieKind = "normal" | "shield";

export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

export type LineIndex = 0 | 1 | 2;

export interface Die {
  id: string;
  value: DieValue;
  kind: DieKind;
}

export type BoardSide = [Die[], Die[], Die[]];

export interface Board {
  player: BoardSide;
  opponent: BoardSide;
}

export interface GameState {
  board: Board;
  turn: Owner;
  playerHeld: boolean;
  rerollAvailable: boolean;
  openingShieldOwner: Owner | null;
  pendingBonus: Owner | null;
}

export type RollMode = "normal" | "shield";

export interface PlaceNormalAction {
  type: "place-normal";
  actor: Owner;
  value: DieValue;
  lineIndex: LineIndex;
  usesAlternate?: boolean;
}

export interface PlaceShieldAction {
  type: "place-shield";
  actor: Owner;
  value: DieValue;
  targetOwner: Owner;
  lineIndex: LineIndex;
  source: "bonus" | "opening" | "manual";
  usesAlternate?: boolean;
}

export interface HoldAction {
  type: "hold";
  actor: "player";
}

export interface RerollAction {
  type: "reroll";
  actor: "player";
  value: DieValue;
}

export type GameAction =
  | PlaceNormalAction
  | PlaceShieldAction
  | HoldAction
  | RerollAction;

export interface ApplyResult {
  state: GameState;
  knocked: Die[];
  placedDie?: Die;
  consumedOpeningShield: boolean;
}

export type Winner = "player" | "opponent" | "draw";

export interface LineOutcome {
  playerScore: number;
  opponentScore: number;
  winner: Winner;
}

export interface GameOutcome {
  winner: Winner;
  lineOutcomes: LineOutcome[];
  playerTotal: number;
  opponentTotal: number;
  playerLineWins: number;
  opponentLineWins: number;
}

export interface ObservationEntry {
  id: string;
  createdAt: string;
  committedAt?: string;
  gameResult?: Winner;
  stateBefore: GameState;
  rollValue: DieValue;
  action: GameAction;
  legalActions: GameAction[];
}

export interface GameRecord {
  id: string;
  createdAt: string;
  result: Winner;
  observationCount: number;
  finalState: GameState;
}

export interface LogEntry {
  id: string;
  createdAt: string;
  message: string;
}

export type AiProfileName = "observed" | "aggressive" | "score" | "blocker";

export interface PolicyWeights {
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

export interface AiMismatchLog {
  id: string;
  createdAt: string;
  rollValue: DieValue;
  actual: string;
  predicted: string;
  actualScore: number;
  predictedScore: number;
  gameResult?: Winner;
}

export interface AiFitDiagnostics {
  observationCount: number;
  accuracy: number;
  top3Accuracy: number;
  averageActualRank: number;
  mismatches: AiMismatchLog[];
}

export interface LearnedAiModel {
  version: number;
  updatedAt: string;
  weights: PolicyWeights;
  diagnostics: AiFitDiagnostics;
  updateLog: Array<{
    id: string;
    createdAt: string;
    observationCount: number;
    accuracy: number;
    top3Accuracy: number;
    averageActualRank: number;
  }>;
}

export interface RecommendationInput {
  state: GameState;
  actor: Owner;
  rollValue: DieValue;
  alternateRollValue: DieValue | null;
  rollMode: RollMode;
  samplesPerAction: number;
  aiProfile: AiProfileName;
  learnedWeights?: PolicyWeights | null;
  seed: number;
}

export interface Recommendation {
  action: GameAction;
  label: string;
  wins: number;
  losses: number;
  draws: number;
  averageScoreDiff: number;
  winRate: number;
  drawRate: number;
  lossRate: number;
  samples: number;
}
