import { useState } from "react";
import type { StepState } from "@/lib/usePipeline";
import { Check, ChevronRight, Loader2, X } from "lucide-react";

interface Props {
  steps: StepState[];
  ambiguous: boolean;
  onRunAnyway: () => void;
  chips?: string[];
}

export function PipelineStrip({ steps, ambiguous, onRunAnyway, chips }: Props) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {ambiguous && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2">
          <span className="text-[11px] text-amber-200">Ambiguous — did you mean:</span>
          {(chips ?? []).map((c) => (
            <button
              key={c}
              onClick={onRunAnyway}
              className="rounded-full border border-amber-700/60 px-2.5 py-0.5 text-[11px] text-amber-100 hover:bg-amber-900/40"
            >
              {c}
            </button>
          ))}
          <button
            onClick={onRunAnyway}
            className="ml-auto text-[11px] text-cyan-400 hover:text-cyan-300"
          >
            Run anyway
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-center">
            {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
            <button
              onClick={() => s.raw !== undefined && setOpenKey(openKey === s.key ? null : s.key)}
              className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                s.status === "done"
                  ? "text-emerald-400"
                  : s.status === "error"
                    ? "text-red-400"
                    : s.status === "active"
                      ? "text-cyan-300"
                      : "text-zinc-600"
              } ${s.raw !== undefined ? "cursor-pointer hover:bg-zinc-800/70" : "cursor-default"}`}
            >
              {s.status === "done" ? (
                <Check className="h-3 w-3" />
              ) : s.status === "active" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : s.status === "error" ? (
                <X className="h-3 w-3" />
              ) : null}
              <span>{s.label}</span>
              {s.meta && <span className="text-zinc-600">· {s.meta}</span>}
            </button>
          </div>
        ))}
      </div>
      {openKey && (
        <pre className="max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[10px] text-zinc-400">
          {JSON.stringify(
            steps.find((s) => s.key === openKey)?.raw,
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}
