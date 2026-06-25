import type {
  Board,
  BoardSide,
  GameOutcome,
  LineOutcome,
  Winner
} from "./types";

export function scoreLine(line: BoardSide[number]): number {
  const counts = new Map<number, number>();

  for (const die of line) {
    counts.set(die.value, (counts.get(die.value) ?? 0) + 1);
  }

  let total = 0;
  for (const [value, count] of counts) {
    total += value * (count === 0 ? 0 : 1 + 2 * (count - 1));
  }

  return total;
}

export function scoreSide(side: BoardSide): number[] {
  return side.map(scoreLine);
}

export function totalScore(side: BoardSide): number {
  return scoreSide(side).reduce((sum, value) => sum + value, 0);
}

export function compareScores(playerScore: number, opponentScore: number): Winner {
  if (playerScore > opponentScore) {
    return "player";
  }

  if (opponentScore > playerScore) {
    return "opponent";
  }

  return "draw";
}

export function evaluateBoard(board: Board): GameOutcome {
  const lineOutcomes: LineOutcome[] = [0, 1, 2].map((lineIndex) => {
    const playerScore = scoreLine(board.player[lineIndex]);
    const opponentScore = scoreLine(board.opponent[lineIndex]);

    return {
      playerScore,
      opponentScore,
      winner: compareScores(playerScore, opponentScore)
    };
  });

  const playerLineWins = lineOutcomes.filter(
    (line) => line.winner === "player"
  ).length;
  const opponentLineWins = lineOutcomes.filter(
    (line) => line.winner === "opponent"
  ).length;
  const playerTotal = totalScore(board.player);
  const opponentTotal = totalScore(board.opponent);

  if (playerLineWins > opponentLineWins) {
    return {
      winner: "player",
      lineOutcomes,
      playerTotal,
      opponentTotal,
      playerLineWins,
      opponentLineWins
    };
  }

  if (opponentLineWins > playerLineWins) {
    return {
      winner: "opponent",
      lineOutcomes,
      playerTotal,
      opponentTotal,
      playerLineWins,
      opponentLineWins
    };
  }

  return {
    winner: compareScores(playerTotal, opponentTotal),
    lineOutcomes,
    playerTotal,
    opponentTotal,
    playerLineWins,
    opponentLineWins
  };
}
