import {
  Brain,
  Download,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Shield,
  Target,
  Trash2,
  Undo2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeActionReason } from "./game/policies";
import { recommendActions } from "./game/recommend";
import {
  actionKey,
  addManualDie,
  applyAction,
  createInitialState,
  formatAction,
  legalActionsForRoll,
  lineIndexes,
  removeDieAt
} from "./game/rules";
import { evaluateBoard, scoreLine } from "./game/scoring";
import type {
  AiProfileName,
  Die,
  DieKind,
  DieValue,
  GameAction,
  GameState,
  LineIndex,
  LogEntry,
  ObservationEntry,
  Owner,
  Recommendation,
  RecommendationInput,
  RollMode
} from "./game/types";

type PlacementAction = Extract<GameAction, { type: "place-normal" }> | Extract<
  GameAction,
  { type: "place-shield" }
>;

const DIE_VALUES: DieValue[] = [1, 2, 3, 4, 5, 6];
const SAMPLE_OPTIONS = [
  { label: "Fast", value: 140 },
  { label: "Balanced", value: 520 },
  { label: "Deep", value: 1200 }
];

function App() {
  const [state, setState] = useLocalStorage<GameState>(
    "tikatuka.state",
    createInitialState()
  );
  const [rollValue, setRollValue] = useLocalStorage<DieValue>(
    "tikatuka.roll",
    1
  );
  const [alternateRollValue, setAlternateRollValue] =
    useLocalStorage<DieValue | null>("tikatuka.alternateRoll", null);
  const [rollMode, setRollMode] = useLocalStorage<RollMode>(
    "tikatuka.rollMode",
    "normal"
  );
  const [samplesPerAction, setSamplesPerAction] = useLocalStorage<number>(
    "tikatuka.samples",
    520
  );
  const [aiProfile, setAiProfile] = useLocalStorage<AiProfileName>(
    "tikatuka.aiProfile",
    "observed"
  );
  const [observations, setObservations] = useLocalStorage<ObservationEntry[]>(
    "tikatuka.observations",
    []
  );
  const [logs, setLogs] = useLocalStorage<LogEntry[]>("tikatuka.logs", []);
  const [history, setHistory] = useState<GameState[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [manualOwner, setManualOwner] = useState<Owner>("player");
  const [manualLine, setManualLine] = useState<LineIndex>(0);
  const [manualValue, setManualValue] = useState<DieValue>(1);
  const [manualKind, setManualKind] = useState<DieKind>("normal");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeActor = state.pendingBonus ?? state.turn;
  const effectiveRollMode: RollMode = state.pendingBonus ? "shield" : rollMode;
  const legalActions = useMemo(
    () =>
      legalActionsForRoll(
        state,
        activeActor,
        rollValue,
        effectiveRollMode,
        alternateRollValue,
        true
      ),
    [activeActor, alternateRollValue, effectiveRollMode, rollValue, state]
  );
  const outcome = useMemo(() => evaluateBoard(state.board), [state.board]);

  useEffect(() => {
    if (!state.pendingBonus && rollMode === "shield") {
      return;
    }

    if (state.pendingBonus && rollMode !== "shield") {
      setRollMode("shield");
    }
  }, [rollMode, setRollMode, state.pendingBonus]);

  function addLog(message: string) {
    setLogs((current) =>
      [
        {
          id: makeId("log"),
          createdAt: new Date().toISOString(),
          message
        },
        ...current
      ].slice(0, 80)
    );
  }

  function commitState(next: GameState, message: string) {
    setHistory((current) => [state, ...current].slice(0, 50));
    setState(next);
    addLog(message);
    setRecommendations([]);
  }

  function applyGameAction(action: GameAction) {
    const before = state;
    const legalBefore = legalActions;

    try {
      const result = applyAction(state, action);
      const messageParts = [formatAction(action)];

      if (result.knocked.length > 0) {
        messageParts.push(`알까기 ${result.knocked.length}개`);
      }

      if (result.state.pendingBonus) {
        messageParts.push("보너스 대기");
      }

      commitState(result.state, messageParts.join(" · "));

      if (action.actor === "opponent") {
        setObservations((current) => [
          {
            id: makeId("obs"),
            createdAt: new Date().toISOString(),
            stateBefore: before,
            rollValue: action.value,
            action,
            legalActions: legalBefore
          },
          ...current
        ]);
      }
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : String(error));
    }
  }

  function calculateRecommendations() {
    setIsCalculating(true);
    setWorkerError(null);

    const input: RecommendationInput = {
      state,
      actor: activeActor,
      rollValue,
      alternateRollValue,
      rollMode: effectiveRollMode,
      samplesPerAction,
      aiProfile,
      seed: Date.now()
    };

    try {
      const worker = new Worker(
        new URL("./worker/recommendationWorker.ts", import.meta.url),
        { type: "module" }
      );

      worker.onmessage = (
        event: MessageEvent<
          | { type: "success"; recommendations: Recommendation[] }
          | { type: "error"; message: string }
        >
      ) => {
        setIsCalculating(false);
        worker.terminate();

        if (event.data.type === "error") {
          setWorkerError(event.data.message);
          return;
        }

        setRecommendations(event.data.recommendations);
      };

      worker.onerror = () => {
        worker.terminate();
        runSynchronousRecommendation(input);
      };

      worker.postMessage(input);
    } catch {
      runSynchronousRecommendation(input);
    }
  }

  function runSynchronousRecommendation(input: RecommendationInput) {
    try {
      setRecommendations(recommendActions(input));
      setWorkerError(null);
    } catch (error) {
      setWorkerError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsCalculating(false);
    }
  }

  function undo() {
    const [previous, ...rest] = history;
    if (!previous) {
      return;
    }

    setState(previous);
    setHistory(rest);
    addLog("Undo");
  }

  function resetGame() {
    commitState(createInitialState(), "새 게임");
    setAlternateRollValue(null);
    setRollMode("normal");
  }

  function removeDie(owner: Owner, lineIndex: LineIndex, dieId: string) {
    commitState(removeDieAt(state, owner, lineIndex, dieId), "주사위 제거");
  }

  function toggleDie(owner: Owner, lineIndex: LineIndex, die: Die) {
    const next = structuredCloneSafe(state);
    const target = next.board[owner][lineIndex].find((item) => item.id === die.id);
    if (target) {
      target.kind = target.kind === "normal" ? "shield" : "normal";
    }
    commitState(next, "주사위 속성 변경");
  }

  function addDie() {
    commitState(
      addManualDie(state, manualOwner, manualLine, manualValue, manualKind),
      "수동 입력"
    );
  }

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      state,
      observations,
      logs
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tikatuka-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importData(file: File) {
    const text = await file.text();
    const payload = JSON.parse(text) as {
      state?: GameState;
      observations?: ObservationEntry[];
      logs?: LogEntry[];
    };

    if (payload.state) {
      setState(payload.state);
    }

    if (payload.observations) {
      setObservations(payload.observations);
    }

    if (payload.logs) {
      setLogs(payload.logs);
    }

    addLog("JSON Import");
  }

  const winnerClass =
    outcome.winner === "draw" ? "neutral" : outcome.winner === "player" ? "good" : "bad";

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>TikaTuka Simulator</h1>
          <p>
            {outcome.playerLineWins}:{outcome.opponentLineWins} ·{" "}
            {outcome.playerTotal}-{outcome.opponentTotal}
          </p>
        </div>

        <div className="topbar-actions">
          <button className="icon-button" onClick={undo} title="Undo">
            <Undo2 size={18} />
          </button>
          <button className="icon-button" onClick={resetGame} title="Reset">
            <RotateCcw size={18} />
          </button>
          <button className="icon-button" onClick={exportData} title="Export">
            <Download size={18} />
          </button>
          <button
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title="Import"
          >
            <Upload size={18} />
          </button>
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept="application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void importData(file);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </section>

      <section className="layout">
        <div className="board-panel">
          <BoardSideView
            owner="opponent"
            state={state}
            legalActions={legalActions}
            onApply={applyGameAction}
            onRemove={removeDie}
            onToggle={toggleDie}
          />
          <div className="turn-strip">
            <SegmentedOwner value={state.turn} onChange={(turn) => setState({ ...state, turn })} />
            <span className={`winner-pill ${winnerClass}`}>
              {outcome.winner === "draw"
                ? "DRAW"
                : outcome.winner === "player"
                  ? "PLAYER"
                  : "OPPONENT"}
            </span>
            {state.pendingBonus && (
              <span className="bonus-pill">
                <Shield size={15} />
                {state.pendingBonus === "player" ? "내 보너스" : "상대 보너스"}
              </span>
            )}
          </div>
          <BoardSideView
            owner="player"
            state={state}
            legalActions={legalActions}
            onApply={applyGameAction}
            onRemove={removeDie}
            onToggle={toggleDie}
          />
        </div>

        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-title">
              <Target size={17} />
              <h2>Roll</h2>
            </div>
            <DieSelector value={rollValue} onChange={setRollValue} />
            <div className="two-column">
              <label>
                Mode
                <select
                  value={effectiveRollMode}
                  disabled={Boolean(state.pendingBonus)}
                  onChange={(event) => setRollMode(event.target.value as RollMode)}
                >
                  <option value="normal">Normal</option>
                  <option value="shield">Shield</option>
                </select>
              </label>
              <label>
                Alt
                <select
                  value={alternateRollValue ?? ""}
                  onChange={(event) =>
                    setAlternateRollValue(
                      event.target.value ? toDieValue(event.target.value) : null
                    )
                  }
                >
                  <option value="">None</option>
                  {DIE_VALUES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="switch-row">
              <label>
                <input
                  type="checkbox"
                  checked={state.rerollAvailable}
                  onChange={(event) =>
                    setState({ ...state, rerollAvailable: event.target.checked })
                  }
                />
                Reroll
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={state.playerHeld}
                  onChange={(event) =>
                    setState({ ...state, playerHeld: event.target.checked })
                  }
                />
                Hold
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={state.openingShieldOwner === "player"}
                  onChange={(event) =>
                    setState({
                      ...state,
                      openingShieldOwner: event.target.checked ? "player" : null
                    })
                  }
                />
                1st shield
              </label>
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Brain size={17} />
              <h2>Recommend</h2>
            </div>
            <div className="two-column">
              <label>
                Profile
                <select
                  value={aiProfile}
                  onChange={(event) => setAiProfile(event.target.value as AiProfileName)}
                >
                  <option value="observed">Observed</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="score">Score</option>
                  <option value="blocker">Blocker</option>
                </select>
              </label>
              <label>
                Samples
                <select
                  value={samplesPerAction}
                  onChange={(event) => setSamplesPerAction(Number(event.target.value))}
                >
                  {SAMPLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className="primary-button"
              onClick={calculateRecommendations}
              disabled={isCalculating}
            >
              <Play size={17} />
              {isCalculating ? "Calculating" : "Calculate"}
            </button>
            {workerError && <p className="error-text">{workerError}</p>}
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Plus size={17} />
              <h2>Manual</h2>
            </div>
            <div className="manual-grid">
              <select
                value={manualOwner}
                onChange={(event) => setManualOwner(event.target.value as Owner)}
              >
                <option value="player">Player</option>
                <option value="opponent">Opponent</option>
              </select>
              <select
                value={manualLine}
                onChange={(event) => setManualLine(Number(event.target.value) as LineIndex)}
              >
                {lineIndexes().map((lineIndex) => (
                  <option key={lineIndex} value={lineIndex}>
                    L{lineIndex + 1}
                  </option>
                ))}
              </select>
              <select
                value={manualValue}
                onChange={(event) => setManualValue(toDieValue(event.target.value))}
              >
                {DIE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <select
                value={manualKind}
                onChange={(event) => setManualKind(event.target.value as DieKind)}
              >
                <option value="normal">Normal</option>
                <option value="shield">Shield</option>
              </select>
            </div>
            <button className="secondary-button" onClick={addDie}>
              <Plus size={16} />
              Add
            </button>
          </section>
        </aside>

        <aside className="analysis-panel">
          <section className="panel-section">
            <div className="section-title">
              <Target size={17} />
              <h2>Actions</h2>
            </div>
            <div className="action-list">
              {recommendations.length === 0 ? (
                legalActions.slice(0, 10).map((action) => (
                  <ActionButton
                    key={actionKey(action)}
                    action={action}
                    state={state}
                    aiProfile={aiProfile}
                    onApply={applyGameAction}
                  />
                ))
              ) : (
                recommendations.map((recommendation, index) => (
                  <RecommendationRow
                    key={actionKey(recommendation.action)}
                    recommendation={recommendation}
                    rank={index + 1}
                    onApply={applyGameAction}
                  />
                ))
              )}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Shield size={17} />
              <h2>Lines</h2>
            </div>
            <div className="line-summary">
              {outcome.lineOutcomes.map((line, index) => (
                <div key={index} className="summary-row">
                  <span>L{index + 1}</span>
                  <strong>
                    {line.playerScore} - {line.opponentScore}
                  </strong>
                  <span className={line.winner}>{line.winner}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Download size={17} />
              <h2>Logs</h2>
            </div>
            <div className="stats-row">
              <span>Obs</span>
              <strong>{observations.length}</strong>
              <span>Log</span>
              <strong>{logs.length}</strong>
            </div>
            <div className="log-list">
              {logs.slice(0, 8).map((log) => (
                <div key={log.id} className="log-row">
                  {log.message}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

interface BoardSideViewProps {
  owner: Owner;
  state: GameState;
  legalActions: GameAction[];
  onApply: (action: GameAction) => void;
  onRemove: (owner: Owner, lineIndex: LineIndex, dieId: string) => void;
  onToggle: (owner: Owner, lineIndex: LineIndex, die: Die) => void;
}

function BoardSideView({
  owner,
  state,
  legalActions,
  onApply,
  onRemove,
  onToggle
}: BoardSideViewProps) {
  const side = state.board[owner];
  const title = owner === "player" ? "PLAYER" : "OPPONENT";

  return (
    <section className={`side-board ${owner}`}>
      <div className="side-title">
        <span>{title}</span>
        <strong>{side.flat().length}/9</strong>
      </div>
      <div className="line-grid">
        {lineIndexes().map((lineIndex) => {
          const lineActions = legalActions.filter((action): action is PlacementAction => {
            if (action.type === "place-normal") {
              return action.actor === owner && action.lineIndex === lineIndex;
            }

            if (action.type === "place-shield") {
              return action.targetOwner === owner && action.lineIndex === lineIndex;
            }

            return false;
          });

          return (
            <div key={lineIndex} className="line-card">
              <div className="line-head">
                <span>L{lineIndex + 1}</span>
                <strong>{scoreLine(side[lineIndex])}</strong>
              </div>
              <div className="slots">
                {[0, 1, 2].map((slotIndex) => {
                  const die = side[lineIndex][slotIndex];
                  return die ? (
                    <DiePill
                      key={die.id}
                      die={die}
                      onRemove={() => onRemove(owner, lineIndex, die.id)}
                      onToggle={() => onToggle(owner, lineIndex, die)}
                    />
                  ) : (
                    <div key={slotIndex} className="slot empty" />
                  );
                })}
              </div>
              <div className="line-actions">
                {lineActions.slice(0, 2).map((action) => (
                  <button
                    key={actionKey(action)}
                    className="mini-action"
                    onClick={() => onApply(action)}
                    title={formatAction(action)}
                  >
                    {action.type === "place-shield" ? (
                      <Shield size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    <span>{action.value}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

interface DiePillProps {
  die: Die;
  onRemove: () => void;
  onToggle: () => void;
}

function DiePill({ die, onRemove, onToggle }: DiePillProps) {
  return (
    <div className={`die-pill ${die.kind}`}>
      <button className="die-main" onClick={onToggle} title="Toggle die kind">
        {die.kind === "shield" && <Shield size={13} />}
        <span>{die.value}</span>
      </button>
      <button className="die-remove" onClick={onRemove} title="Remove die">
        <X size={12} />
      </button>
    </div>
  );
}

function DieSelector({
  value,
  onChange
}: {
  value: DieValue;
  onChange: (value: DieValue) => void;
}) {
  return (
    <div className="die-selector">
      {DIE_VALUES.map((dieValue) => (
        <button
          key={dieValue}
          className={dieValue === value ? "selected" : ""}
          onClick={() => onChange(dieValue)}
        >
          {dieValue}
        </button>
      ))}
    </div>
  );
}

function SegmentedOwner({
  value,
  onChange
}: {
  value: Owner;
  onChange: (owner: Owner) => void;
}) {
  return (
    <div className="segmented">
      <button
        className={value === "player" ? "selected" : ""}
        onClick={() => onChange("player")}
      >
        Player
      </button>
      <button
        className={value === "opponent" ? "selected" : ""}
        onClick={() => onChange("opponent")}
      >
        Opponent
      </button>
    </div>
  );
}

function ActionButton({
  action,
  state,
  aiProfile,
  onApply
}: {
  action: GameAction;
  state: GameState;
  aiProfile: AiProfileName;
  onApply: (action: GameAction) => void;
}) {
  return (
    <button className="action-row" onClick={() => onApply(action)}>
      <span>{formatAction(action)}</span>
      <small>{describeActionReason(state, action, aiProfile).split(": ")[1]}</small>
    </button>
  );
}

function RecommendationRow({
  recommendation,
  rank,
  onApply
}: {
  recommendation: Recommendation;
  rank: number;
  onApply: (action: GameAction) => void;
}) {
  const pct = Math.round(recommendation.winRate * 1000) / 10;

  return (
    <button className="recommendation-row" onClick={() => onApply(recommendation.action)}>
      <span className="rank">{rank}</span>
      <span className="rec-main">
        <strong>{recommendation.label}</strong>
        <small>
          W {pct}% · D {(recommendation.drawRate * 100).toFixed(1)}% · Δ{" "}
          {recommendation.averageScoreDiff.toFixed(1)}
        </small>
      </span>
      <span className="rec-bar">
        <i style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
    </button>
  );
}

function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return initialValue;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue];
}

function toDieValue(value: string): DieValue {
  const numberValue = Number(value);
  if (!DIE_VALUES.includes(numberValue as DieValue)) {
    return 1;
  }

  return numberValue as DieValue;
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default App;
