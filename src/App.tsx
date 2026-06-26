import {
  Brain,
  Download,
  Play,
  Plus,
  RotateCcw,
  Save,
  Shield,
  Target,
  Undo2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeActionReason } from "./game/policies";
import { choosePolicyAction } from "./game/policies";
import {
  createInitialLearnedModel,
  tuneLearnedAiModel
} from "./game/learning";
import { recommendActions } from "./game/recommend";
import {
  actionKey,
  addManualDie,
  advanceTurn,
  applyAction,
  canAct,
  createInitialState,
  formatAction,
  isTerminal,
  legalActionsForRoll,
  lineIndexes,
  normalPlacementWouldKnock,
  removeDieAt
} from "./game/rules";
import { createRng, rollDie, rollDifferentDie } from "./game/random";
import { evaluateBoard, scoreLine } from "./game/scoring";
import type {
  AiProfileName,
  Die,
  DieKind,
  DieValue,
  GameRecord,
  GameAction,
  GameState,
  LearnedAiModel,
  LineIndex,
  LogEntry,
  ObservationEntry,
  Owner,
  Recommendation,
  RecommendationInput,
  RollMode,
  Winner
} from "./game/types";

type PlacementAction = Extract<GameAction, { type: "place-normal" }> | Extract<
  GameAction,
  { type: "place-shield" }
>;

interface ManualDialogState {
  owner: Owner;
  lineIndex: LineIndex;
}

interface PracticeRollFlash {
  id: string;
  value: DieValue;
  mode: RollMode;
}

const DIE_VALUES: DieValue[] = [1, 2, 3, 4, 5, 6];
const SAMPLE_OPTIONS = [
  { label: "빠르게", value: 140 },
  { label: "균형", value: 520 },
  { label: "깊게", value: 1200 }
];

const OWNER_LABEL: Record<Owner, string> = {
  player: "나",
  opponent: "상대"
};

const WINNER_LABEL = {
  player: "내 승리",
  opponent: "상대 우세",
  draw: "무승부"
};

const RESULT_LABEL: Record<Winner, string> = {
  player: "승리",
  opponent: "패배",
  draw: "무승부"
};

const AI_PROFILE_LABEL: Record<AiProfileName, string> = {
  observed: "관찰형",
  aggressive: "알까기 우선",
  score: "점수 우선",
  blocker: "방해 우선"
};

function App() {
  const [route, setRoute] = useState(() => currentRoute());

  useEffect(() => {
    const onRouteChange = () => setRoute(currentRoute());
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
    return () => {
      window.removeEventListener("popstate", onRouteChange);
      window.removeEventListener("hashchange", onRouteChange);
    };
  }, []);

  function navigate(path: string) {
    window.history.pushState(null, "", path);
    setRoute(currentRoute());
  }

  if (route === "/practice") {
    return <PracticeView navigate={navigate} />;
  }

  return <SimulatorView navigate={navigate} />;
}

function SimulatorView({ navigate }: { navigate: (path: string) => void }) {
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
  const [samplesPerAction, setSamplesPerAction] = useLocalStorage<number>(
    "tikatuka.samples",
    520
  );
  const [aiProfile, setAiProfile] = useLocalStorage<AiProfileName>(
    "tikatuka.aiProfile",
    "observed"
  );
  const [starter, setStarter] = useLocalStorage<Owner>(
    "tikatuka.starter",
    "player"
  );
  const [observations, setObservations] = useLocalStorage<ObservationEntry[]>(
    "tikatuka.observations",
    []
  );
  const [pendingObservations, setPendingObservations] = useLocalStorage<
    ObservationEntry[]
  >("tikatuka.pendingObservations", []);
  const [gameRecords, setGameRecords] = useLocalStorage<GameRecord[]>(
    "tikatuka.gameRecords",
    []
  );
  const [learnedAiModel, setLearnedAiModel] =
    useLocalStorage<LearnedAiModel>(
      "tikatuka.learnedAiModel",
      createInitialLearnedModel()
    );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [history, setHistory] = useState<GameState[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [manualDialog, setManualDialog] = useState<ManualDialogState | null>(
    null
  );
  const [manualValue, setManualValue] = useState<DieValue>(1);
  const [manualKind, setManualKind] = useState<DieKind>("normal");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeActor = state.pendingBonus ?? state.turn;
  const effectiveRollMode: RollMode = state.pendingBonus ? "shield" : "normal";
  const effectiveAlternateRollValue =
    activeActor === "player" && !state.pendingBonus ? alternateRollValue : null;
  const tunedAiProfile = useMemo(
    () =>
      aiProfile === "observed"
        ? inferObservedProfile(observations)
        : aiProfile,
    [aiProfile, observations]
  );
  const learnedWeights =
    aiProfile === "observed" ? learnedAiModel.weights : null;
  const rollStatus = state.pendingBonus
    ? `${OWNER_LABEL[state.pendingBonus]} 보너스 쉴드`
    : state.openingShieldOwner === activeActor
      ? "첫 주사위 자동 쉴드"
      : "일반 주사위";
  const legalActions = useMemo(
    () =>
      legalActionsForRoll(
        state,
        activeActor,
        rollValue,
        effectiveRollMode,
        effectiveAlternateRollValue,
        true
      ),
    [
      activeActor,
      effectiveAlternateRollValue,
      effectiveRollMode,
      rollValue,
      state
    ]
  );
  const outcome = useMemo(() => evaluateBoard(state.board), [state.board]);

  useEffect(() => {
    if (alternateRollValue === rollValue) {
      setAlternateRollValue(null);
    }
  }, [alternateRollValue, rollValue, setAlternateRollValue]);

  function changeStarter(owner: Owner) {
    setStarter(owner);
    if (isFreshOpeningState(state)) {
      setState({
        ...state,
        turn: owner,
        openingShieldOwner: owner
      });
    }
  }

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

      if (
        action.actor === "opponent" &&
        (action.type === "place-normal" || action.type === "place-shield")
      ) {
        setPendingObservations((current) => [
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
      alternateRollValue: effectiveAlternateRollValue,
      rollMode: effectiveRollMode,
      samplesPerAction,
      aiProfile: tunedAiProfile,
      learnedWeights,
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
    addLog("되돌리기");
  }

  function resetGame() {
    commitState(createInitialState(starter), "새 게임");
    setAlternateRollValue(null);
    setPendingObservations([]);
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
    if (!manualDialog) {
      return;
    }

    commitState(
      addManualDie(
        state,
        manualDialog.owner,
        manualDialog.lineIndex,
        manualValue,
        manualKind
      ),
      "수동 입력"
    );
    setManualDialog(null);
  }

  function recordGameResult(result: Winner) {
    const now = new Date().toISOString();
    const committedObservations = pendingObservations.map((observation) => ({
      ...observation,
      committedAt: now,
      gameResult: result
    }));

    if (committedObservations.length > 0) {
      const nextObservations = [...committedObservations, ...observations].slice(
        0,
        2000
      );
      setObservations(nextObservations);
      setLearnedAiModel((current) =>
        tuneLearnedAiModel(nextObservations, current)
      );
    }

    setGameRecords((current) =>
      [
        {
          id: makeId("game"),
          createdAt: now,
          result,
          observationCount: pendingObservations.length,
          finalState: state
        },
        ...current
      ].slice(0, 300)
    );
    setPendingObservations([]);
    addLog(
      `결과 저장: ${RESULT_LABEL[result]} · 관찰 ${pendingObservations.length}개`
    );
  }

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      state,
      observations,
      pendingObservations,
      gameRecords,
      learnedAiModel
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
      pendingObservations?: ObservationEntry[];
      gameRecords?: GameRecord[];
      learnedAiModel?: LearnedAiModel;
    };

    if (payload.state) {
      setState(payload.state);
    }

    if (payload.observations) {
      setObservations(payload.observations);
    }

    if (payload.pendingObservations) {
      setPendingObservations(payload.pendingObservations);
    }

    if (payload.gameRecords) {
      setGameRecords(payload.gameRecords);
    }

    if (payload.learnedAiModel) {
      setLearnedAiModel(payload.learnedAiModel);
    }

    addLog("백업 불러오기");
  }

  const winnerClass =
    outcome.winner === "draw" ? "neutral" : outcome.winner === "player" ? "good" : "bad";

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>티카투카 시뮬레이터</h1>
          <p>
            라인 {outcome.playerLineWins}:{outcome.opponentLineWins} · 총점{" "}
            {outcome.playerTotal}-{outcome.opponentTotal}
          </p>
        </div>

        <div className="topbar-actions">
          <StarterSelect value={starter} onChange={changeStarter} />
          <button className="nav-button" onClick={() => navigate("/practice")}>
            AI 연습
          </button>
          <span className="save-pill" title="현재 브라우저에 자동 저장됩니다">
            <Save size={16} />
            자동 저장
          </span>
          <button className="icon-button" onClick={undo} title="되돌리기" aria-label="되돌리기">
            <Undo2 size={18} />
          </button>
          <button className="icon-button" onClick={resetGame} title="새 게임" aria-label="새 게임">
            <RotateCcw size={18} />
          </button>
          <button className="icon-button" onClick={exportData} title="백업 내보내기" aria-label="백업 내보내기">
            <Download size={18} />
          </button>
          <button
            className="icon-button"
            onClick={() => fileInputRef.current?.click()}
            title="백업 불러오기"
            aria-label="백업 불러오기"
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
            onEmptySlot={(owner, lineIndex) =>
              setManualDialog({ owner, lineIndex })
            }
          />
          <div className="turn-strip">
            <SegmentedOwner value={state.turn} onChange={(turn) => setState({ ...state, turn })} />
            <span className="actor-pill">현재 행동: {OWNER_LABEL[activeActor]}</span>
            <span className={`winner-pill ${winnerClass}`}>
              {WINNER_LABEL[outcome.winner]}
            </span>
            {state.pendingBonus && (
              <span className="bonus-pill">
                <Shield size={15} />
                {OWNER_LABEL[state.pendingBonus]} 보너스
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
            onEmptySlot={(owner, lineIndex) =>
              setManualDialog({ owner, lineIndex })
            }
          />
        </div>

        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-title">
              <Target size={17} />
              <h2>현재 주사위</h2>
            </div>
            <span className={`roll-status ${state.pendingBonus ? "bonus" : ""}`}>
              {rollStatus}
            </span>
            <DieSelector value={rollValue} onChange={setRollValue} />
            <div className="single-column">
              <label>
                리롤값
                <select
                  value={alternateRollValue ?? ""}
                  disabled={activeActor !== "player" || Boolean(state.pendingBonus)}
                  onChange={(event) =>
                    setAlternateRollValue(
                      event.target.value ? toDieValue(event.target.value) : null
                    )
                  }
                >
                  <option value="">없음</option>
                  {DIE_VALUES.filter((value) => value !== rollValue).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="switch-row two-items">
              <label>
                <input
                  type="checkbox"
                  checked={state.rerollAvailable}
                  onChange={(event) =>
                    setState({ ...state, rerollAvailable: event.target.checked })
                  }
                />
                리롤 가능
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={state.playerHeld}
                  onChange={(event) =>
                    setState({ ...state, playerHeld: event.target.checked })
                  }
                />
                홀드함
              </label>
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Brain size={17} />
              <h2>추천 계산</h2>
            </div>
            <div className="two-column">
              <label>
                AI 성향
                <select
                  value={aiProfile}
                  onChange={(event) => setAiProfile(event.target.value as AiProfileName)}
                >
                  <option value="observed">{AI_PROFILE_LABEL.observed}</option>
                  <option value="aggressive">{AI_PROFILE_LABEL.aggressive}</option>
                  <option value="score">{AI_PROFILE_LABEL.score}</option>
                  <option value="blocker">{AI_PROFILE_LABEL.blocker}</option>
                </select>
              </label>
              <label>
                정밀도
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
            {aiProfile === "observed" && (
              <ModelDiagnosticsCard model={learnedAiModel} />
            )}
            <button
              className="primary-button"
              onClick={calculateRecommendations}
              disabled={isCalculating}
            >
              <Play size={17} />
              {isCalculating ? "계산 중" : "추천 계산"}
            </button>
            {workerError && <p className="error-text">{workerError}</p>}
          </section>

        </aside>

        <aside className="analysis-panel">
          <section className="panel-section">
            <div className="section-title">
              <Target size={17} />
              <h2>선택지</h2>
            </div>
            <div className="action-list">
              {recommendations.length === 0 ? (
                legalActions.slice(0, 10).map((action) => (
                  <ActionButton
                    key={actionKey(action)}
                    action={action}
                    state={state}
                    aiProfile={tunedAiProfile}
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
              <h2>라인 점수</h2>
            </div>
            <div className="line-summary">
              {outcome.lineOutcomes.map((line, index) => (
                <div key={index} className="summary-row">
                  <span>L{index + 1}</span>
                  <strong>
                    {line.playerScore} - {line.opponentScore}
                  </strong>
                  <span className={line.winner}>{WINNER_LABEL[line.winner]}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Save size={17} />
              <h2>결과 저장</h2>
            </div>
            <div className="result-actions">
              <button className="result-button win" onClick={() => recordGameResult("player")}>
                승리
              </button>
              <button className="result-button loss" onClick={() => recordGameResult("opponent")}>
                패배
              </button>
              <button className="result-button draw" onClick={() => recordGameResult("draw")}>
                무승부
              </button>
            </div>
            <div className="stats-row compact">
              <span>임시 관찰</span>
              <strong>{pendingObservations.length}</strong>
              <span>확정 판수</span>
              <strong>{gameRecords.length}</strong>
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Download size={17} />
              <h2>기록</h2>
            </div>
            <div className="stats-row">
              <span>확정 관찰</span>
              <strong>{observations.length}</strong>
              <span>로그</span>
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
      {manualDialog && (
        <ManualDieDialog
          dialog={manualDialog}
          value={manualValue}
          kind={manualKind}
          onValueChange={setManualValue}
          onKindChange={setManualKind}
          onClose={() => setManualDialog(null)}
          onConfirm={addDie}
        />
      )}
    </main>
  );
}

function PracticeView({ navigate }: { navigate: (path: string) => void }) {
  const [practiceState, setPracticeState] = useLocalStorage<GameState>(
    "tikatuka.practice.state",
    createInitialState()
  );
  const [currentRoll, setCurrentRoll] = useLocalStorage<DieValue | null>(
    "tikatuka.practice.roll",
    null
  );
  const [practiceAlternateRoll, setPracticeAlternateRoll] =
    useLocalStorage<DieValue | null>("tikatuka.practice.alternateRoll", null);
  const [aiProfile, setAiProfile] = useLocalStorage<AiProfileName>(
    "tikatuka.practice.aiProfile",
    "observed"
  );
  const [learnedAiModel] = useLocalStorage<LearnedAiModel>(
    "tikatuka.learnedAiModel",
    createInitialLearnedModel()
  );
  const [starter, setStarter] = useLocalStorage<Owner>(
    "tikatuka.practice.starter",
    "player"
  );
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [manualDialog, setManualDialog] = useState<ManualDialogState | null>(
    null
  );
  const [manualValue, setManualValue] = useState<DieValue>(1);
  const [manualKind, setManualKind] = useState<DieKind>("normal");
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [lastOpponentRoll, setLastOpponentRoll] =
    useState<PracticeRollFlash | null>(null);
  const [practiceRecommendations, setPracticeRecommendations] = useState<
    Recommendation[]
  >([]);
  const [isPracticeCalculating, setIsPracticeCalculating] = useState(false);
  const [practiceRecommendationError, setPracticeRecommendationError] =
    useState<string | null>(null);
  const rngRef = useRef(createRng(Date.now()));
  const aiTimerRef = useRef<number | null>(null);

  const activeActor = practiceState.pendingBonus ?? practiceState.turn;
  const learnedWeights =
    aiProfile === "observed" ? learnedAiModel.weights : null;
  const isPlayerBonus = practiceState.pendingBonus === "player";
  const playerRollMode: RollMode = isPlayerBonus ? "shield" : "normal";
  const outcome = useMemo(
    () => evaluateBoard(practiceState.board),
    [practiceState.board]
  );
  const playerLegalActions = useMemo(() => {
    if (activeActor !== "player" || currentRoll === null) {
      return [];
    }

    return legalActionsForRoll(
      practiceState,
      "player",
      currentRoll,
      playerRollMode,
      practiceAlternateRoll,
      true
    );
  }, [
    activeActor,
    currentRoll,
    playerRollMode,
    practiceAlternateRoll,
    practiceState
  ]);
  const rerollAction = playerLegalActions.find(
    (action): action is Extract<GameAction, { type: "reroll" }> =>
      action.type === "reroll"
  );
  const holdAction = playerLegalActions.find(
    (action): action is Extract<GameAction, { type: "hold" }> =>
      action.type === "hold"
  );

  useEffect(() => {
    if (currentRoll !== null && practiceAlternateRoll === currentRoll) {
      setPracticeAlternateRoll(null);
    }
  }, [currentRoll, practiceAlternateRoll, setPracticeAlternateRoll]);

  function changePracticeStarter(owner: Owner) {
    setStarter(owner);
    if (isFreshOpeningState(practiceState)) {
      setPracticeState({
        ...practiceState,
        turn: owner,
        openingShieldOwner: owner
      });
      setCurrentRoll(null);
      setPracticeAlternateRoll(null);
    }
  }

  useEffect(() => {
    if (isTerminal(practiceState)) {
      return;
    }

    if (activeActor === "player") {
      if (!practiceState.pendingBonus && !canAct(practiceState, "player")) {
        setPracticeState(advanceTurn(practiceState));
        setCurrentRoll(null);
        setPracticeAlternateRoll(null);
        return;
      }

      if (currentRoll === null) {
        setCurrentRoll(rollDie(rngRef.current));
      }
    }
  }, [
    activeActor,
    currentRoll,
    practiceState,
    setCurrentRoll,
    setPracticeAlternateRoll,
    setPracticeState
  ]);

  useEffect(() => {
    if (
      isTerminal(practiceState) ||
      activeActor !== "player" ||
      currentRoll === null ||
      playerLegalActions.length === 0
    ) {
      setIsPracticeCalculating(false);
      setPracticeRecommendations([]);
      return;
    }

    const input: RecommendationInput = {
      state: practiceState,
      actor: "player",
      rollValue: currentRoll,
      alternateRollValue: practiceAlternateRoll,
      rollMode: playerRollMode,
      samplesPerAction: 260,
      aiProfile,
      learnedWeights,
      seed: Date.now()
    };
    let cancelled = false;
    setIsPracticeCalculating(true);
    setPracticeRecommendationError(null);

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
        worker.terminate();
        if (cancelled) {
          return;
        }

        setIsPracticeCalculating(false);
        if (event.data.type === "error") {
          setPracticeRecommendationError(event.data.message);
          return;
        }

        setPracticeRecommendations(event.data.recommendations);
      };

      worker.onerror = () => {
        worker.terminate();
        if (cancelled) {
          return;
        }

        runPracticeRecommendation(input);
      };

      worker.postMessage(input);

      return () => {
        cancelled = true;
        worker.terminate();
      };
    } catch {
      runPracticeRecommendation(input);
    }

    return () => {
      cancelled = true;
    };
  }, [
    activeActor,
    aiProfile,
    currentRoll,
    learnedWeights,
    playerLegalActions.length,
    playerRollMode,
    practiceAlternateRoll,
    practiceState
  ]);

  useEffect(() => {
    if (
      isTerminal(practiceState) ||
      activeActor !== "opponent"
    ) {
      if (activeActor !== "opponent") {
        setIsAiThinking(false);
      }
      return;
    }

    if (aiTimerRef.current !== null) {
      return;
    }

    setIsAiThinking(true);
    aiTimerRef.current = window.setTimeout(() => {
      try {
        setPracticeState((current) => {
          const actor = current.pendingBonus ?? current.turn;

          if (actor !== "opponent" || isTerminal(current)) {
            return current;
          }

          if (!current.pendingBonus && !canAct(current, "opponent")) {
            return advanceTurn(current);
          }

          const value = rollDie(rngRef.current);
          const mode: RollMode = current.pendingBonus ? "shield" : "normal";
          const openingShield =
            current.openingShieldOwner === "opponent" &&
            current.board.opponent.flat().length === 0;
          setLastOpponentRoll({
            id: makeId("opponent-roll"),
            value,
            mode: current.pendingBonus || openingShield ? "shield" : "normal"
          });
          const action = choosePolicyAction(
            current,
            "opponent",
            value,
            mode,
            aiProfile,
            rngRef.current,
            null,
            learnedWeights
          );

          if (!action) {
            return advanceTurn(current);
          }

          const result = applyAction(current, action);
          addPracticeLog(
            `${
              mode === "shield"
                ? "상대 보너스"
                : openingShield
                  ? "상대 첫 쉴드"
                  : "상대"
            } ${value}: ${formatAction(action)}${
              result.knocked.length > 0 ? ` · 알까기 ${result.knocked.length}개` : ""
            }`
          );
          return result.state;
        });
        setCurrentRoll(null);
        setPracticeAlternateRoll(null);
      } catch (error) {
        addPracticeLog(
          `AI 오류: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        aiTimerRef.current = null;
        setIsAiThinking(false);
      }
    }, 520);
  }, [
    activeActor,
    aiProfile,
    learnedWeights,
    practiceState,
    setCurrentRoll,
    setPracticeAlternateRoll,
    setPracticeState
  ]);

  function addPracticeLog(message: string) {
    setLogs((current) =>
      [
        {
          id: makeId("practice-log"),
          createdAt: new Date().toISOString(),
          message
        },
        ...current
      ].slice(0, 60)
    );
  }

  function runPracticeRecommendation(input: RecommendationInput) {
    try {
      setPracticeRecommendations(recommendActions(input));
      setPracticeRecommendationError(null);
    } catch (error) {
      setPracticeRecommendationError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsPracticeCalculating(false);
    }
  }

  function applyPlayerAction(action: GameAction) {
    if (action.type === "reroll") {
      const result = applyAction(practiceState, action);
      setPracticeState(result.state);
      setPracticeAlternateRoll(rollDifferentDie(rngRef.current, action.value));
      addPracticeLog("리롤 사용");
      return;
    }

    const result = applyAction(practiceState, action);
    setPracticeState(result.state);
    setCurrentRoll(null);
    setPracticeAlternateRoll(null);
    setPracticeRecommendations([]);
    setIsPracticeCalculating(false);
    addPracticeLog(
      `${formatAction(action)}${
        result.knocked.length > 0 ? ` · 알까기 ${result.knocked.length}개` : ""
      }`
    );
  }

  function resetPractice() {
    setPracticeState(createInitialState(starter));
    setCurrentRoll(null);
    setPracticeAlternateRoll(null);
    setPracticeRecommendations([]);
    setLastOpponentRoll(null);
    setLogs([]);
  }

  function addPracticeDie() {
    if (!manualDialog) {
      return;
    }

    setPracticeState((current) =>
      addManualDie(
        current,
        manualDialog.owner,
        manualDialog.lineIndex,
        manualValue,
        manualKind
      )
    );
    setManualDialog(null);
    addPracticeLog("수동 입력");
  }

  const statusText = isTerminal(practiceState)
    ? `게임 종료: ${RESULT_LABEL[outcome.winner]}`
    : activeActor === "opponent"
      ? isAiThinking
        ? "AI 생각 중"
        : "AI 턴"
      : isPlayerBonus
        ? "내 보너스 쉴드"
        : practiceState.openingShieldOwner === "player" &&
            practiceState.board.player.flat().length === 0
          ? "첫 주사위 자동 쉴드"
          : "내 턴";

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>AI 연습 모드</h1>
          <p>
            라인 {outcome.playerLineWins}:{outcome.opponentLineWins} · 총점{" "}
            {outcome.playerTotal}-{outcome.opponentTotal}
          </p>
        </div>
        <div className="topbar-actions">
          <StarterSelect value={starter} onChange={changePracticeStarter} />
          <button className="nav-button" onClick={() => navigate("/")}>
            추천 도구
          </button>
          <button className="icon-button" onClick={resetPractice} title="새 연습">
            <RotateCcw size={18} />
          </button>
        </div>
      </section>

      <section className="layout practice-layout">
        <div className="board-panel">
          <BoardSideView
            owner="opponent"
            state={practiceState}
            legalActions={playerLegalActions}
            onApply={applyPlayerAction}
            onRemove={(owner, lineIndex, dieId) =>
              setPracticeState((current) => removeDieAt(current, owner, lineIndex, dieId))
            }
            onToggle={(owner, lineIndex, die) =>
              setPracticeState((current) => toggleDieInState(current, owner, lineIndex, die.id))
            }
            onEmptySlot={(owner, lineIndex) => setManualDialog({ owner, lineIndex })}
          />
          <div className="turn-strip">
            <div className="practice-dice-stage">
              <span className={`actor-pill ${activeActor}`}>{statusText}</span>
              <div className="dice-spotlights">
                <PracticeRollDisplay
                  label="상대 주사위"
                  roll={lastOpponentRoll}
                  isThinking={activeActor === "opponent" && isAiThinking}
                  owner="opponent"
                />
                <PracticeRollDisplay
                  label={isPlayerBonus ? "내 보너스" : "내 주사위"}
                  roll={
                    currentRoll
                      ? {
                          id: `player-${currentRoll}-${practiceAlternateRoll ?? "main"}`,
                          value: practiceAlternateRoll ?? currentRoll,
                          mode: isPlayerBonus ? "shield" : "normal"
                        }
                      : null
                  }
                  alternateValue={practiceAlternateRoll ? currentRoll : null}
                  isThinking={false}
                  owner="player"
                />
              </div>
              {(rerollAction || holdAction) && activeActor === "player" && (
                <div className="practice-utility-actions">
                  {rerollAction && (
                    <button onClick={() => applyPlayerAction(rerollAction)}>
                      리롤
                    </button>
                  )}
                  {holdAction && (
                    <button onClick={() => applyPlayerAction(holdAction)}>
                      홀드
                    </button>
                  )}
                </div>
              )}
            </div>
            <span className="winner-pill neutral">{WINNER_LABEL[outcome.winner]}</span>
          </div>
          <BoardSideView
            owner="player"
            state={practiceState}
            legalActions={playerLegalActions}
            onApply={applyPlayerAction}
            onRemove={(owner, lineIndex, dieId) =>
              setPracticeState((current) => removeDieAt(current, owner, lineIndex, dieId))
            }
            onToggle={(owner, lineIndex, die) =>
              setPracticeState((current) => toggleDieInState(current, owner, lineIndex, die.id))
            }
            onEmptySlot={(owner, lineIndex) => setManualDialog({ owner, lineIndex })}
          />
        </div>

        <aside className="control-panel">
          <section className="panel-section">
            <div className="section-title">
              <Brain size={17} />
              <h2>상대 AI</h2>
            </div>
            <label>
              성향
              <select
                value={aiProfile}
                onChange={(event) => setAiProfile(event.target.value as AiProfileName)}
              >
                <option value="observed">{AI_PROFILE_LABEL.observed}</option>
                <option value="aggressive">{AI_PROFILE_LABEL.aggressive}</option>
                <option value="score">{AI_PROFILE_LABEL.score}</option>
                <option value="blocker">{AI_PROFILE_LABEL.blocker}</option>
              </select>
            </label>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Target size={17} />
              <h2>자동 확률 계산</h2>
            </div>
            <PracticeProbabilityPanel
              isCalculating={isPracticeCalculating}
              error={practiceRecommendationError}
              recommendations={practiceRecommendations}
              activeActor={activeActor}
              currentRoll={currentRoll}
            />
          </section>
        </aside>

        <aside className="analysis-panel practice-analysis">
          <section className="panel-section">
            <div className="section-title">
              <Shield size={17} />
              <h2>라인 점수</h2>
            </div>
            <div className="line-summary">
              {outcome.lineOutcomes.map((line, index) => (
                <div key={index} className="summary-row">
                  <span>L{index + 1}</span>
                  <strong>
                    {line.playerScore} - {line.opponentScore}
                  </strong>
                  <span className={line.winner}>{WINNER_LABEL[line.winner]}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <Download size={17} />
              <h2>연습 로그</h2>
            </div>
            <div className="log-list">
              {logs.slice(0, 10).map((log) => (
                <div key={log.id} className="log-row">
                  {log.message}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>

      {manualDialog && (
        <ManualDieDialog
          dialog={manualDialog}
          value={manualValue}
          kind={manualKind}
          onValueChange={setManualValue}
          onKindChange={setManualKind}
          onClose={() => setManualDialog(null)}
          onConfirm={addPracticeDie}
        />
      )}
    </main>
  );
}

function PracticeRollDisplay({
  label,
  roll,
  alternateValue,
  isThinking,
  owner
}: {
  label: string;
  roll: PracticeRollFlash | null;
  alternateValue?: DieValue | null;
  isThinking: boolean;
  owner: Owner;
}) {
  return (
    <div
      key={roll?.id ?? `${owner}-empty`}
      className={`practice-roll-display ${owner} ${roll?.mode === "shield" ? "shield" : ""} ${
        isThinking ? "thinking" : ""
      }`}
    >
      <small>{label}</small>
      <strong>{isThinking ? "?" : roll?.value ?? "-"}</strong>
      {alternateValue && <em>리롤 전 {alternateValue}</em>}
    </div>
  );
}

function PracticeProbabilityPanel({
  isCalculating,
  error,
  recommendations,
  activeActor,
  currentRoll
}: {
  isCalculating: boolean;
  error: string | null;
  recommendations: Recommendation[];
  activeActor: Owner;
  currentRoll: DieValue | null;
}) {
  if (activeActor === "opponent") {
    return <div className="empty-note">상대 턴이 끝나면 자동 계산</div>;
  }

  if (currentRoll === null) {
    return <div className="empty-note">내 주사위 대기 중</div>;
  }

  if (isCalculating) {
    return <div className="calculating-note">계산 중</div>;
  }

  if (error) {
    return <p className="error-text">{error}</p>;
  }

  if (recommendations.length === 0) {
    return <div className="empty-note">계산 결과 없음</div>;
  }

  return (
    <div className="probability-list">
      {recommendations.slice(0, 6).map((recommendation, index) => {
        const pct = Math.round(recommendation.winRate * 1000) / 10;
        return (
          <div key={actionKey(recommendation.action)} className="probability-row">
            <span className="rank">{index + 1}</span>
            <span className="rec-main">
              <strong>{recommendation.label}</strong>
              <small>
                승 {pct}% · 무 {(recommendation.drawRate * 100).toFixed(1)}% ·
                점수차 {recommendation.averageScoreDiff.toFixed(1)}
              </small>
            </span>
            <span className="rec-bar">
              <i style={{ width: `${Math.max(2, pct)}%` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface BoardSideViewProps {
  owner: Owner;
  state: GameState;
  legalActions: GameAction[];
  onApply: (action: GameAction) => void;
  onRemove: (owner: Owner, lineIndex: LineIndex, dieId: string) => void;
  onToggle: (owner: Owner, lineIndex: LineIndex, die: Die) => void;
  onEmptySlot: (owner: Owner, lineIndex: LineIndex) => void;
}

function BoardSideView({
  owner,
  state,
  legalActions,
  onApply,
  onRemove,
  onToggle,
  onEmptySlot
}: BoardSideViewProps) {
  const side = state.board[owner];
  const title = owner === "player" ? "내 필드" : "상대 필드";

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
                    <button
                      key={slotIndex}
                      className="slot empty slot-button"
                      onClick={() => onEmptySlot(owner, lineIndex)}
                      title="주사위 추가"
                      aria-label={`${title} ${lineIndex + 1}번 라인 주사위 추가`}
                    >
                      <Plus size={16} />
                    </button>
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
      <button className="die-main" onClick={onToggle} title="일반/쉴드 변경">
        {die.kind === "shield" && <Shield size={13} />}
        <span>{die.value}</span>
      </button>
      <button className="die-remove" onClick={onRemove} title="주사위 제거">
        <X size={12} />
      </button>
    </div>
  );
}

function ManualDieDialog({
  dialog,
  value,
  kind,
  onValueChange,
  onKindChange,
  onClose,
  onConfirm
}: {
  dialog: ManualDialogState;
  value: DieValue;
  kind: DieKind;
  onValueChange: (value: DieValue) => void;
  onKindChange: (kind: DieKind) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <section
        className="manual-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-title">
          <h2 id="manual-dialog-title">주사위 추가</h2>
          <button className="icon-button" onClick={onClose} title="닫기">
            <X size={17} />
          </button>
        </div>
        <p className="dialog-target">
          {OWNER_LABEL[dialog.owner]} · L{dialog.lineIndex + 1}
        </p>
        <DieSelector value={value} onChange={onValueChange} />
        <div className="kind-selector">
          <button
            className={kind === "normal" ? "selected" : ""}
            onClick={() => onKindChange("normal")}
          >
            일반
          </button>
          <button
            className={kind === "shield" ? "selected" : ""}
            onClick={() => onKindChange("shield")}
          >
            <Shield size={15} />
            쉴드
          </button>
        </div>
        <button className="primary-button" onClick={onConfirm}>
          <Plus size={16} />
          추가
        </button>
      </section>
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
        내 턴
      </button>
      <button
        className={value === "opponent" ? "selected" : ""}
        onClick={() => onChange("opponent")}
      >
        상대 턴
      </button>
    </div>
  );
}

function StarterSelect({
  value,
  onChange
}: {
  value: Owner;
  onChange: (owner: Owner) => void;
}) {
  return (
    <label className="starter-select">
      선공
      <select value={value} onChange={(event) => onChange(event.target.value as Owner)}>
        <option value="player">나</option>
        <option value="opponent">상대</option>
      </select>
    </label>
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
          승 {pct}% · 무 {(recommendation.drawRate * 100).toFixed(1)}% · 점수차{" "}
          {recommendation.averageScoreDiff.toFixed(1)}
        </small>
      </span>
      <span className="rec-bar">
        <i style={{ width: `${Math.max(2, pct)}%` }} />
      </span>
    </button>
  );
}

function ModelDiagnosticsCard({ model }: { model: LearnedAiModel }) {
  const diagnostics = model.diagnostics;
  const observationCount = diagnostics.observationCount ?? 0;
  const totalObservationCount =
    diagnostics.totalObservationCount ?? observationCount;
  const ignoredObservationCount = diagnostics.ignoredObservationCount ?? 0;
  const nearTopAccuracy =
    diagnostics.nearTopAccuracy ?? diagnostics.top3Accuracy ?? diagnostics.accuracy;
  const averageRank = diagnostics.averageActualRank || 0;
  const mismatchCategories = summarizeMismatchCategories(
    diagnostics.mismatches ?? []
  );

  return (
    <div className="model-diagnostics">
      <span className="model-pill">
        모델 v{model.version} · 사용 관찰 {observationCount}/{totalObservationCount}개
        {ignoredObservationCount > 0 && ` · 의심 제외 ${ignoredObservationCount}개`}
      </span>
      <div className="model-metrics">
        <span>
          Top1 <strong>{formatPercent(diagnostics.accuracy)}</strong>
        </span>
        <span>
          근접 <strong>{formatPercent(nearTopAccuracy)}</strong>
        </span>
        <span>
          Top3 <strong>{formatPercent(diagnostics.top3Accuracy)}</strong>
        </span>
        <span>
          평균 <strong>{averageRank.toFixed(2)}등</strong>
        </span>
      </div>
      {mismatchCategories.length > 0 && (
        <div className="model-mismatch-tags">
          {mismatchCategories.slice(0, 3).map(([category, count]) => (
            <span key={category}>
              {category} {count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizeMismatchCategories(
  mismatches: LearnedAiModel["diagnostics"]["mismatches"]
): Array<[string, number]> {
  const counts = new Map<string, number>();

  for (const mismatch of mismatches) {
    const category = mismatch.category ?? "기타";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatPercent(value: number | undefined): string {
  return `${((value ?? 0) * 100).toFixed(0)}%`;
}

function inferObservedProfile(observations: ObservationEntry[]): AiProfileName {
  const recent = observations
    .filter((entry) => entry.action.actor === "opponent")
    .slice(0, 200);

  if (recent.length < 6) {
    return "observed";
  }

  let knockOpportunities = 0;
  let knockChoices = 0;
  let shieldChoices = 0;
  let lowShieldToPlayer = 0;
  let highShieldToSelf = 0;

  for (const entry of recent) {
    const hadKnockOption = entry.legalActions.some((action) => {
      if (action.type !== "place-normal" || action.actor !== "opponent") {
        return false;
      }

      return (
        normalPlacementWouldKnock(
          entry.stateBefore,
          "opponent",
          action.value,
          action.lineIndex
        ).length > 0
      );
    });

    if (hadKnockOption) {
      knockOpportunities += 1;
    }

    if (
      entry.action.type === "place-normal" &&
      normalPlacementWouldKnock(
        entry.stateBefore,
        "opponent",
        entry.action.value,
        entry.action.lineIndex
      ).length > 0
    ) {
      knockChoices += 1;
    }

    if (entry.action.type === "place-shield") {
      shieldChoices += 1;
      if (entry.action.targetOwner === "player" && entry.action.value <= 2) {
        lowShieldToPlayer += 1;
      }
      if (entry.action.targetOwner === "opponent" && entry.action.value >= 4) {
        highShieldToSelf += 1;
      }
    }
  }

  const knockRate =
    knockOpportunities > 0 ? knockChoices / knockOpportunities : 0;
  const blockRate = shieldChoices > 0 ? lowShieldToPlayer / shieldChoices : 0;
  const scoreRate = shieldChoices > 0 ? highShieldToSelf / shieldChoices : 0;

  if (blockRate >= 0.45) {
    return "blocker";
  }

  if (knockRate >= 0.8) {
    return "aggressive";
  }

  if (scoreRate >= 0.55) {
    return "score";
  }

  return "observed";
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

function toggleDieInState(
  state: GameState,
  owner: Owner,
  lineIndex: LineIndex,
  dieId: string
): GameState {
  const next = structuredCloneSafe(state);
  const target = next.board[owner][lineIndex].find((die) => die.id === dieId);

  if (target) {
    target.kind = target.kind === "normal" ? "shield" : "normal";
  }

  return next;
}

function isFreshOpeningState(state: GameState): boolean {
  return (
    state.board.player.flat().length === 0 &&
    state.board.opponent.flat().length === 0 &&
    state.pendingBonus === null
  );
}

function currentRoute(): string {
  if (window.location.pathname === "/practice") {
    return "/practice";
  }

  if (window.location.hash === "#/practice") {
    return "/practice";
  }

  return "/";
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default App;
