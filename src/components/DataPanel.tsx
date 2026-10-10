import { useState } from "react";
import Papa from "papaparse";
import {
  ChevronDown,
  ChevronRight,
  Database,
  FileSpreadsheet,
  KeyRound,
  Upload,
} from "lucide-react";
import type { ColRef } from "@/lib/routing";
import { supabase } from "@/lib/supabase";
import type { SchemaTable } from "@/lib/types";

interface Props {
  schema: SchemaTable[];
  selectedCols: ColRef[];
  onSchemaChanged: () => void;
}

export function DataPanel({ schema, selectedCols, onSchemaChanged }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");

  const toggle = (t: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });

  async function handleFile(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      setUploadMsg("File exceeds the 5 MB limit.");
      return;
    }
    setUploading(true);
    setUploadMsg("");
    try {
      const text = await file.text();
      const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
      const rows = parsed.data;
      if (!rows.length) throw new Error("No data rows found");
      if (rows.length > 50000) throw new Error("File exceeds the 50,000 row limit.");
      await supabase.functions.invoke("data", {
        body: { action: "upload", name: file.name, rows },
      });
      setUploadMsg(`Uploaded ${rows.length} rows as a new table.`);
      onSchemaChanged();
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <aside className="w-full lg:w-80 shrink-0 space-y-4">
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Database className="h-4 w-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-zinc-100">Your data</h2>
        </div>
        <div className="space-y-1 max-h-96 overflow-y-auto pr-1">
          {schema.length === 0 && (
            <p className="text-xs text-zinc-500">Loading tables...</p>
          )}
          {schema.map((t) => {
            const open = expanded.has(t.table);
            return (
              <div key={t.table}>
                <button
                  onClick={() => toggle(t.table)}
                  className="w-full flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-medium text-zinc-200 hover:bg-zinc-800/70"
                >
                  {open ? (
                    <ChevronDown className="h-3 w-3 text-zinc-500" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-zinc-500" />
                  )}
                  <FileSpreadsheet className="h-3 w-3 text-cyan-500/70" />
                  {t.table}
                </button>
                {open && (
                  <div className="ml-5 border-l border-zinc-800 pl-2 py-0.5 space-y-0.5">
                    {t.columns.map((c) => {
                      const sel = selectedCols.find(
                        (s) => s.table === t.table && s.column === c.column,
                      );
                      return (
                        <div key={c.column} className="relative rounded px-1.5 py-0.5">
                          {sel && (
                            <div
                              className="absolute inset-y-0 left-0 rounded bg-cyan-500/15"
                              style={{ width: `${Math.max(8, sel.noul * 100)}%` }}
                            />
                          )}
                          <div className="relative flex items-center gap-1.5">
                            <KeyRound
                              className={`h-2.5 w-2.5 ${
                                /(^|_)id$|_id$/i.test(c.column)
                                  ? "text-amber-500/80"
                                  : "text-transparent"
                              }`}
                            />
                            <span
                              className={`text-[11px] font-mono ${
                                sel ? "text-cyan-300" : "text-zinc-400"
                              }`}
                            >
                              {c.column}
                            </span>
                            <span className="text-[10px] text-zinc-600">{c.type}</span>
                            {sel && (
                              <span className="ml-auto text-[10px] text-cyan-400/80">
                                {sel.noul.toFixed(2)}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(f);
        }}
        className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4 text-center"
      >
        <Upload className="mx-auto h-5 w-5 text-zinc-500 mb-1.5" />
        <p className="text-xs text-zinc-400">
          Drop a CSV here to add your own table
        </p>
        <p className="text-[10px] text-zinc-600 mt-0.5">Up to 5 MB and 50,000 rows</p>
        <label className="mt-2 inline-block cursor-pointer rounded-md bg-cyan-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-500">
          {uploading ? "Uploading..." : "Choose file"}
          <input
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </label>
        {uploadMsg && <p className="mt-2 text-[11px] text-cyan-300">{uploadMsg}</p>}
      </div>
    </aside>
  );
}
