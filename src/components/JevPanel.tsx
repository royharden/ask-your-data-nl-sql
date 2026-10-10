import type { JevAnswers } from "@/lib/types";
import type { ColRef, RouteResult } from "@/lib/routing";
import { Activity, CheckCircle2, XCircle, Circle } from "lucide-react";

interface Props {
  jevAnswers: JevAnswers | null;
  routeResult: RouteResult | null;
  decision: string;
  firedRules: { rule: string; detail: string }[];
  jevStats: { latency: number; cost: number; tokens: number };
  clarifyTable: Record<string, number> | null;
  onPickTable: (t: string) => void;
}

export function JevPanel({
  jevAnswers,
  decision,
  firedRules,
  jevStats,
  clarifyTable,
  onPickTable,
}: Props) {
  if (!jevAnswers) {
    return (
      <aside className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs text-zinc-500">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="h-4 w-4 text-cyan-400" />
          <span className="font-semibold text-zinc-200">Jev</span>
        </div>
        Ask a question to see how Jev routes it.
      </aside>
    );
  }

  const answerable = (jevAnswers.answerable as { noul?: number })?.noul ?? 0;
  const needsJoin = (jevAnswers.needs_join as { noul?: number })?.noul ?? 0;
  const ambiguous = (jevAnswers.ambiguous as { noul?: number })?.noul ?? 0;
  const table = (jevAnswers.table as { probabilities?: Record<string, number> }) ?? {};
  const probs = table.probabilities ?? {};
  const colEntries = Object.entries(jevAnswers)
    .filter(([k]) => k.startsWith("col__"))
    .map(([k, v]) => {
      const parts = k.replace("col__", "").split("__");
      return {
        table: parts[0],
        column: parts.slice(1).join("__"),
        noul: (v as { noul?: number })?.noul ?? 0,
      };
    })
    .filter((c) => c.noul > 0)
    .sort((a, b) => b.noul - a.noul)
    .slice(0, 12);

  const answerableColor =
    answerable >= 0.6 ? "text-emerald-400" : answerable >= 0.4 ? "text-amber-400" : "text-red-400";

  return (
    <aside className="space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="h-4 w-4 text-cyan-400" />
          <span className="text-sm font-semibold text-zinc-100">Jev</span>
          <span className="ml-auto text-[10px] text-zinc-500">
            {jevStats.latency} ms · {jevStats.tokens} tok · ${jevStats.cost.toFixed(6)}
          </span>
        </div>

        <div className="mb-3">
          <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
            <span>Answerable</span>
            <span className={answerableColor}>{(answerable * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded ${
                answerable >= 0.6
                  ? "bg-emerald-500"
                  : answerable >= 0.4
                    ? "bg-amber-500"
                    : "bg-red-500"
              }`}
              style={{ width: `${answerable * 100}%` }}
            />
          </div>
        </div>

        <div className="mb-3 space-y-1">
          <p className="text-[11px] text-zinc-500">Table probabilities</p>
          {Object.entries(probs).length === 0 && (
            <p className="text-[10px] text-zinc-600">No probabilities returned.</p>
          )}
          {Object.entries(probs)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([t, p]) => (
              <div key={t} className="flex items-center gap-2">
                <span className="w-28 truncate text-[10px] font-mono text-zinc-400">{t}</span>
                <div className="h-1.5 flex-1 rounded bg-zinc-800 overflow-hidden">
                  <div className="h-full bg-cyan-500" style={{ width: `${p * 100}%` }} />
                </div>
                <span className="w-8 text-right text-[10px] text-zinc-500">
                  {(p * 100).toFixed(0)}
                </span>
              </div>
            ))}
        </div>

        {colEntries.length > 0 && (
          <div className="mb-3 space-y-1">
            <p className="text-[11px] text-zinc-500">Column relevance</p>
            {colEntries.map((c) => (
              <div key={`${c.table}.${c.column}`} className="flex items-center gap-2">
                <span className="w-28 truncate text-[10px] font-mono text-zinc-400">{c.column}</span>
                <div className="h-1.5 flex-1 rounded bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-cyan-500/70"
                    style={{ width: `${c.noul * 100}%` }}
                  />
                </div>
                <span className="w-8 text-right text-[10px] text-zinc-500">
                  {c.noul.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] ${
              needsJoin >= 0.5
                ? "bg-cyan-950/60 text-cyan-300"
                : "bg-zinc-800 text-zinc-500"
            }`}
          >
            join: {(needsJoin * 100).toFixed(0)}%
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] ${
              ambiguous >= 0.6
                ? "bg-amber-950/60 text-amber-300"
                : "bg-zinc-800 text-zinc-500"
            }`}
          >
            ambiguous: {(ambiguous * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      {clarifyTable && Object.keys(clarifyTable).length > 0 && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4">
          <p className="text-xs font-semibold text-amber-200 mb-2">Which table did you mean?</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(clarifyTable)
              .sort((a, b) => b[1] - a[1])
              .map(([t, p]) => (
                <button
                  key={t}
                  onClick={() => onPickTable(t)}
                  className="rounded-full border border-amber-700/60 px-2.5 py-1 text-[11px] text-amber-100 hover:bg-amber-900/40"
                >
                  {t} ({(p * 100).toFixed(0)}%)
                </button>
              ))}
          </div>
        </div>
      )}

      {firedRules.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <p className="text-xs font-semibold text-zinc-200 mb-2">Rules fired</p>
          <ul className="space-y-1">
            {firedRules.map((r, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] text-zinc-400">
                <Circle className="mt-0.5 h-2 w-2 shrink-0 text-cyan-500" />
                <span>
                  <span className="text-zinc-300">{r.rule}</span> — {r.detail}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {decision && (
        <div className="flex items-center gap-2 text-[11px] text-zinc-500">
          {decision === "refuse_unanswerable" ? (
            <XCircle className="h-3.5 w-3.5 text-red-400" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          )}
          decision: <span className="font-mono text-zinc-400">{decision}</span>
        </div>
      )}
    </aside>
  );
}
