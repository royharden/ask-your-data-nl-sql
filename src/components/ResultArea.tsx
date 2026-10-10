import { useState } from "react";
import type { ChartSpec, SqlResult } from "@/lib/types";
import {
  BarChart3,
  LineChart as LineChartIcon,
  PieChart as PieChartIcon,
  Table as TableIcon,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = ["#22d3ee", "#34d399", "#fbbf24", "#f87171", "#a3e635", "#38bdf8", "#c084fc", "#fb923c"];

interface Props {
  result: SqlResult | null;
  chartSpec: ChartSpec;
  onChartTypeChange: (t: ChartSpec["type"]) => void;
  explanation: string;
  sqlText: string;
  onSqlChange: (s: string) => void;
  onRunEdited: () => void;
  busy: boolean;
  sqlRaw?: unknown;
}

function Table({ result }: { result: SqlResult }) {
  return (
    <div className="overflow-auto max-h-72 rounded-lg border border-zinc-800">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            {result.columns.map((c) => (
              <th key={c} className="border-b border-zinc-800 px-3 py-2 text-left font-medium text-zinc-300">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i} className="odd:bg-zinc-900/40">
              {result.columns.map((c) => (
                <td key={c} className="px-3 py-1.5 text-zinc-400 font-mono">
                  {r[c] === null || r[c] === undefined ? "—" : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Chart({ result, spec }: { result: SqlResult; spec: ChartSpec }) {
  const x = spec.x ?? result.columns[0];
  const yRaw = spec.y ?? result.columns[1];
  const ys = Array.isArray(yRaw) ? yRaw : [yRaw];
  const data = result.rows;

  if (!x || !ys[0] || data.length === 0) return <Table result={result} />;

  if (spec.type === "line") {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis dataKey={x} tick={{ fill: "#a1a1aa", fontSize: 11 }} />
          <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
            labelStyle={{ color: "#e4e4e7" }}
          />
          {ys.map((y) => (
            <Line key={y} type="monotone" dataKey={y} stroke="#22d3ee" strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (spec.type === "pie") {
    return (
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie data={data} dataKey={ys[0]} nameKey={x} outerRadius={100} label={false}>
            {data.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
          />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // bar default
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
        <XAxis dataKey={x} tick={{ fill: "#a1a1aa", fontSize: 11 }} interval={0} angle={-15} height={50} />
        <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} />
        <Tooltip
          contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
          labelStyle={{ color: "#e4e4e7" }}
        />
        <Bar dataKey={ys[0]} fill="#22d3ee" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ResultArea(props: Props) {
  const { result, chartSpec, explanation, sqlText, onSqlChange, onRunEdited, busy, sqlRaw } = props;
  const [showRaw, setShowRaw] = useState(false);

  return (
    <section className="space-y-4">
      {result && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">Result</h3>
            <div className="flex gap-1">
              {(
                [
                  ["bar", BarChart3],
                  ["line", LineChartIcon],
                  ["pie", PieChartIcon],
                  ["table", TableIcon],
                ] as const
              ).map(([t, Icon]) => (
                <button
                  key={t}
                  onClick={() => props.onChartTypeChange(t)}
                  className={`rounded p-1.5 ${
                    chartSpec.type === t
                      ? "bg-cyan-600/20 text-cyan-400"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                  title={t}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
          {chartSpec.type === "table" ? (
            <Table result={result} />
          ) : (
            <Chart result={result} spec={chartSpec} />
          )}
          <div className="mt-3">
            <Table result={result} />
          </div>
        </div>
      )}

      {sqlText && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-zinc-100">SQL</h3>
            <button
              onClick={onRunEdited}
              disabled={busy}
              className="rounded-md bg-cyan-600/90 px-3 py-1 text-xs font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              Run edited SQL
            </button>
          </div>
          <textarea
            value={sqlText}
            onChange={(e) => onSqlChange(e.target.value)}
            spellCheck={false}
            rows={6}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-cyan-100 outline-none focus:border-cyan-700"
          />
          {sqlRaw !== undefined && (
            <div className="mt-2">
              <button
                onClick={() => setShowRaw((v) => !v)}
                className="text-[11px] text-zinc-500 hover:text-zinc-300"
              >
                {showRaw ? "Hide" : "Show"} raw JSON
              </button>
              {showRaw && (
                <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-[10px] text-zinc-500">
                  {JSON.stringify(sqlRaw, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {explanation && (
        <div className="rounded-xl border border-cyan-900/60 bg-cyan-950/20 p-4">
          <h3 className="text-sm font-semibold text-cyan-200 mb-1">Explanation</h3>
          <p className="text-sm leading-relaxed text-cyan-50/90">{explanation}</p>
        </div>
      )}
    </section>
  );
}
