import { useCallback, useState } from "react";
import { invokeFn, supabase } from "./supabase";
import { route, type ColRef } from "./routing";
import type {
  ChartSpec,
  FiredRule,
  JevAnswers,
  Policy,
  SchemaTable,
  SqlResult,
} from "./types";

export interface StepState {
  key: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  meta?: string;
  raw?: unknown;
}

export interface HistoryEntry {
  question: string;
  sql?: string;
  chart?: ChartSpec;
  explanation?: string;
  refused?: boolean;
  at: string;
}

const DEMO_QUESTIONS: { text: string; hint?: string }[] = [
  { text: "Which 5 products made the most revenue in Q3?", hint: "join orders and products" },
  { text: "How did mobile orders trend month by month?", hint: "line chart" },
  { text: "Which city has the highest average order size?", hint: "join stores" },
  { text: "What's our customer churn rate?", hint: "expect NOT answerable" },
  { text: "Show me the best stores", hint: "expect ambiguous" },
  { text: "What's the weather in Denver?", hint: "expect not answerable" },
];

export function usePipeline(policy: Policy, mockMode: boolean) {
  const [steps, setSteps] = useState<StepState[]>([]);
  const [jevAnswers, setJevAnswers] = useState<JevAnswers | null>(null);
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [schemaSlice, setSchemaSlice] = useState<SchemaTable[]>([]);
  const [selectedCols, setSelectedCols] = useState<ColRef[]>([]);
  const [firedRules, setFiredRules] = useState<FiredRule[]>([]);
  const [decision, setDecision] = useState<string>("");
  const [sqlText, setSqlText] = useState<string>("");
  const [result, setResult] = useState<SqlResult | null>(null);
  const [chartSpec, setChartSpec] = useState<ChartSpec>({ type: "bar" });
  const [explanation, setExplanation] = useState<string>("");
  const [jevStats, setJevStats] = useState<{ latency: number; cost: number; tokens: number }>({
    latency: 0,
    cost: 0,
    tokens: 0,
  });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string>("");
  const [limitReached, setLimitReached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clarifyTable, setClarifyTable] = useState<Record<string, number> | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);

  const loadSchema = useCallback(async () => {
    try {
      const data = await invokeFn<{ tables: SchemaTable[] }>("data", { action: "schema" });
      setSchema(data.tables ?? []);
      return data.tables ?? [];
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  const setStep = (key: string, patch: Partial<StepState>) =>
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const ask = useCallback(
    async (question: string) => {
      if (!question.trim() || busy) return;
      setBusy(true);
      setError("");
      setLimitReached(false);
      setResult(null);
      setExplanation("");
      setSqlText("");
      setJevAnswers(null);
      setSchemaSlice([]);
      setSelectedCols([]);
      setFiredRules([]);
      setClarifyTable(null);
      setAmbiguous(false);

      const stepDefs = [
        { key: "jev", label: "Jev route" },
        { key: "slice", label: "Schema slice" },
        { key: "sql", label: "SQL drafted" },
        { key: "valid", label: "Validated" },
        { key: "exec", label: "Executed" },
        { key: "explain", label: "Explained" },
      ];
      setSteps(stepDefs.map((s) => ({ ...s, status: "pending" })));

      let questionId: string | null = null;
      try {
        // persist question
        const { data: q } = await supabase
          .from("questions")
          .insert({ text: question, dataset: "demo", mode: mockMode ? "mock" : "live" })
          .select("id")
          .single();
        questionId = q?.id ?? null;

        // 1. Jev routing
        setStep("jev", { status: "active" });
        const jev = await invokeFn<{
          answers: JevAnswers;
          model: string;
          latency_ms: number;
          input_tokens: number;
          cost_usd: number;
          error?: string;
          table?: { probabilities?: Record<string, number> };
        }>("jev-route", { user_question: question, schema });

        if (jev.error) throw new Error(jev.error);

        setJevAnswers(jev.answers);
        setJevStats({
          latency: jev.latency_ms ?? 0,
          cost: jev.cost_usd ?? 0,
          tokens: jev.input_tokens ?? 0,
        });
        setStep("jev", {
          status: "done",
          meta: `${jev.latency_ms} ms · $${(jev.cost_usd ?? 0).toFixed(6)}`,
          raw: jev,
        });

        // 2. Routing policy (pure TS)
        const rr = route(jev.answers, policy, schema);
        setSchemaSlice(rr.schemaSlice);
        setSelectedCols(rr.selectedCols);
        setFiredRules(rr.firedRules);
        setDecision(rr.decision);
        setStep("slice", {
          status: "done",
          meta: `${rr.schemaSlice.length} table(s)`,
          raw: rr.schemaSlice,
        });

        // record routing
        if (questionId) {
          await supabase.from("routing").insert({
            question_id: questionId,
            jev_request: { user_question: question, schema },
            jev_response: jev,
            model: jev.model,
            latency_ms: jev.latency_ms,
            input_tokens: jev.input_tokens,
            cost_usd: jev.cost_usd,
            decision: rr.decision,
            fired_rules: rr.firedRules,
            schema_slice: rr.schemaSlice,
            policy,
          });
        }

        if (rr.decision === "refuse_unanswerable") {
          setStep("sql", { status: "error", meta: "refused" });
          setStep("valid", { status: "error", meta: "refused" });
          setStep("exec", { status: "error", meta: "refused" });
          setStep("explain", { status: "active" });
          try {
            const m = await invokeFn<{ missing: string }>("llm", {
              action: "missing",
              question,
              schema,
              mock: mockMode,
            });
            setExplanation(m.missing);
          } catch {
            setExplanation("Data needed for this question is not available.");
          }
          setStep("explain", { status: "done", meta: "missing data" });
          setHistory((h) =>
            [{ question, refused: true, at: new Date().toISOString() }, ...h].slice(0, 30),
          );
          return;
        }

        if (rr.decision === "clarify_table") {
          setClarifyTable(jev.table?.probabilities ?? {});
          setStep("sql", { status: "error", meta: "needs table pick" });
          setStep("valid", { status: "error", meta: "waiting" });
          setStep("exec", { status: "error", meta: "waiting" });
          setStep("explain", { status: "pending" });
          return;
        }

        setAmbiguous(rr.decision === "ask_clarification");

        // 3. Write SQL from slice
        setStep("sql", { status: "active" });
        const gen = await invokeFn<{
          sql: string;
          chart: ChartSpec;
          assumptions: string[];
          error?: string;
        }>("llm", {
          action: "write_sql",
          question,
          schema: rr.schemaSlice,
          mock: mockMode,
        });
        if (gen.error) throw new Error(gen.error);
        setSqlText(gen.sql);
        setChartSpec(gen.chart ?? { type: "bar" });
        setStep("sql", { status: "done", meta: gen.chart?.type ?? "bar", raw: gen });

        // 4+5. Validate & execute via the data function (validator runs there)
        setStep("valid", { status: "active" });
        setStep("exec", { status: "active" });
        const run = await invokeFn<SqlResult & { error?: string }>("data", {
          action: "run",
          sql: gen.sql,
        });
        if (run.error) {
          setStep("valid", { status: "error", meta: "invalid" });
          setStep("exec", { status: "error", meta: "failed" });
          throw new Error(run.error);
        }
        setStep("valid", { status: "done", meta: "read-only" });
        setStep("exec", {
          status: "done",
          meta: `${run.row_count} rows · ${run.exec_ms} ms`,
          raw: run,
        });
        setResult(run);

        // 6. Explain
        setStep("explain", { status: "active" });
        const exp = await invokeFn<{ explanation: string }>("llm", {
          action: "explain",
          question,
          sql: run.sql,
          rows: run.rows.slice(0, 50),
          mock: mockMode,
        });
        setExplanation(exp.explanation);
        setStep("explain", { status: "done", meta: "done", raw: exp });

        await supabase.from("queries").insert({
          question_id: questionId,
          sql: run.sql,
          chart: gen.chart ?? { type: "bar" },
          valid: true,
          row_count: run.row_count,
          exec_ms: run.exec_ms,
          explanation: exp.explanation,
          edited_by_user: false,
        });

        setHistory((h) =>
          [
            {
              question,
              sql: run.sql,
              chart: gen.chart ?? { type: "bar" },
              explanation: exp.explanation,
              at: new Date().toISOString(),
            },
            ...h,
          ].slice(0, 30),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Daily demo limit/i.test(msg)) {
          setLimitReached(true);
        } else {
          setError(msg);
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, policy, mockMode, schema],
  );

  const runEditedSql = useCallback(
    async (edited: string) => {
      setBusy(true);
      setError("");
      try {
        const run = await invokeFn<SqlResult & { error?: string }>("data", {
          action: "run",
          sql: edited,
        });
        if (run.error) throw new Error(run.error);
        setResult(run);
        setSqlText(edited);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const rerun = useCallback(
    (q: string) => {
      ask(q);
    },
    [ask],
  );

  return {
    steps,
    jevAnswers,
    schema,
    schemaSlice,
    selectedCols,
    firedRules,
    decision,
    sqlText,
    setSqlText,
    result,
    chartSpec,
    explanation,
    jevStats,
    history,
    error,
    limitReached,
    busy,
    clarifyTable,
    ambiguous,
    ask,
    runEditedSql,
    rerun,
    loadSchema,
    setChartSpec,
    DEMO_QUESTIONS,
  };
}
