import { useEffect, useMemo, useState } from "react";
import { AskBar } from "@/components/AskBar";
import { DataPanel } from "@/components/DataPanel";
import { JevPanel } from "@/components/JevPanel";
import { PipelineStrip } from "@/components/PipelineStrip";
import { ResultArea } from "@/components/ResultArea";
import { usePipeline } from "@/lib/usePipeline";
import { PRESETS, type Policy } from "@/lib/types";
import { History, ListChecks, Scale, SlidersHorizontal } from "lucide-react";

type PresetName = keyof typeof PRESETS;

function App() {
  const [mockMode, setMockMode] = useState(false);
  const [policy, setPolicy] = useState<Policy>(PRESETS.Balanced);
  const [historyOpen, setHistoryOpen] = useState(false);
  const pipeline = usePipeline(policy, mockMode);

  useEffect(() => {
    pipeline.loadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats = useMemo(() => {
    return {
      asked: pipeline.history.length,
      refused: pipeline.history.filter((h) => h.refused).length,
      avgLatency: pipeline.jevStats.latency,
      cost: pipeline.jevStats.cost,
    };
  }, [pipeline.history, pipeline.jevStats]);

  const onPickTable = (t: string) => {
    if (pipeline.clarifyTable) {
      const lastQ = pipeline.history[0]?.question;
      if (lastQ) pipeline.ask(`${lastQ} (use the ${t} table)`);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Hero header */}
      <header className="border-b border-zinc-800/80 bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-6 py-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              Ask Your Data
              <span className="ml-2 text-sm font-normal text-zinc-500">
                Jev reads the schema, the LLM writes the SQL.
              </span>
            </h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-lg border border-zinc-800 p-0.5 text-xs">
              <button
                onClick={() => setMockMode(false)}
                className={`rounded-md px-3 py-1.5 ${
                  !mockMode ? "bg-cyan-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Live LLM
              </button>
              <button
                onClick={() => setMockMode(true)}
                className={`rounded-md px-3 py-1.5 ${
                  mockMode ? "bg-cyan-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                Mock LLM
              </button>
            </div>
          </div>
        </div>
      </header>

      {pipeline.limitReached && (
        <div className="border-b border-amber-800/50 bg-amber-950/40 px-6 py-2.5 text-center text-xs text-amber-200">
          Daily demo limit reached — please come back tomorrow.
        </div>
      )}
      {pipeline.error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-6 py-2.5 text-center text-xs text-red-300">
          {pipeline.error}
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[20rem_1fr_20rem]">
        {/* Left: data panel */}
        <DataPanel
          schema={pipeline.schema}
          selectedCols={pipeline.selectedCols}
          onSchemaChanged={pipeline.loadSchema}
        />

        {/* Center */}
        <div className="space-y-5 min-w-0">
          <AskBar
            onAsk={pipeline.ask}
            presetQuestions={pipeline.DEMO_QUESTIONS}
            busy={pipeline.busy}
          />

          <PipelineStrip
            steps={pipeline.steps}
            ambiguous={pipeline.ambiguous}
            onRunAnyway={() => {
              // user chose to proceed despite ambiguity; just re-ask
              const last = pipeline.history[0]?.question;
              if (last) pipeline.ask(last);
            }}
          />

          <ResultArea
            result={pipeline.result}
            chartSpec={pipeline.chartSpec}
            onChartTypeChange={(t) => pipeline.setChartSpec({ ...pipeline.chartSpec, type: t })}
            explanation={pipeline.explanation}
            sqlText={pipeline.sqlText}
            onSqlChange={pipeline.setSqlText}
            onRunEdited={() => pipeline.runEditedSql(pipeline.sqlText)}
            busy={pipeline.busy}
          />
        </div>

        {/* Right: Jev + policy + stats + history */}
        <div className="space-y-5">
          <JevPanel
            jevAnswers={pipeline.jevAnswers}
            routeResult={null}
            decision={pipeline.decision}
            firedRules={pipeline.firedRules}
            jevStats={pipeline.jevStats}
            clarifyTable={pipeline.clarifyTable}
            onPickTable={onPickTable}
          />

          {/* Policy sliders */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold">Routing policy</h2>
            </div>
            <div className="mb-3 flex gap-1.5">
              {(Object.keys(PRESETS) as PresetName[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPolicy(PRESETS[p])}
                  className={`rounded-md border px-2 py-1 text-[11px] ${
                    policy === PRESETS[p]
                      ? "border-cyan-700 bg-cyan-950/60 text-cyan-300"
                      : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            {(
              [
                ["answerableMin", "Answerable min"],
                ["tableMinConfidence", "Table min confidence"],
                ["ambiguityAsk", "Ambiguity ask"],
                ["colKeep", "Column keep"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="mb-2">
                <div className="flex justify-between text-[11px] text-zinc-400">
                  <span>{label}</span>
                  <span className="font-mono text-zinc-300">{policy[key].toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={policy[key]}
                  onChange={(e) => setPolicy({ ...policy, [key]: Number(e.target.value) })}
                  className="w-full accent-cyan-500"
                />
              </div>
            ))}
          </div>

          {/* Stats */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div className="mb-3 flex items-center gap-2">
              <ListChecks className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold">Stats</h2>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-lg bg-zinc-900 p-2">
                <dt className="text-zinc-500">Questions asked</dt>
                <dd className="text-base font-semibold text-zinc-100">{stats.asked}</dd>
              </div>
              <div className="rounded-lg bg-zinc-900 p-2">
                <dt className="text-zinc-500">Refused</dt>
                <dd className="text-base font-semibold text-zinc-100">{stats.refused}</dd>
              </div>
              <div className="rounded-lg bg-zinc-900 p-2">
                <dt className="text-zinc-500">Jev latency</dt>
                <dd className="text-base font-semibold text-zinc-100">{stats.avgLatency} ms</dd>
              </div>
              <div className="rounded-lg bg-zinc-900 p-2">
                <dt className="text-zinc-500">Jev cost</dt>
                <dd className="text-base font-semibold text-zinc-100">
                  ${stats.cost.toFixed(6)}
                </dd>
              </div>
            </dl>
          </div>

          {/* History */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex w-full items-center gap-2"
            >
              <History className="h-4 w-4 text-cyan-400" />
              <h2 className="text-sm font-semibold">History</h2>
              <span className="ml-auto text-[11px] text-zinc-500">
                {historyOpen ? "Hide" : "Show"}
              </span>
            </button>
            {historyOpen && (
              <ul className="mt-3 space-y-1.5">
                {pipeline.history.length === 0 && (
                  <li className="text-[11px] text-zinc-600">No questions yet.</li>
                )}
                {pipeline.history.map((h, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px]">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                        h.refused ? "bg-red-500" : "bg-emerald-500"
                      }`}
                    />
                    <span className="flex-1 text-zinc-400">{h.question}</span>
                    <button
                      onClick={() => pipeline.rerun(h.question)}
                      className="text-cyan-500 hover:text-cyan-400"
                    >
                      re-run
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
