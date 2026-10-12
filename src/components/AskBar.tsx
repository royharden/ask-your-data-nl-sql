import { Send, Sparkles } from "lucide-react";
import { useState } from "react";

interface Props {
  onAsk: (q: string) => void;
  presetQuestions: { text: string; hint?: string }[];
  busy: boolean;
}

export function AskBar({ onAsk, presetQuestions, busy }: Props) {
  const [value, setValue] = useState("");

  return (
    <div className="space-y-2.5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onAsk(value);
        }}
        className="flex gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={400}
          placeholder="Ask a question about your data..."
          className="flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-cyan-700"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
        >
          <Send className="h-4 w-4" />
          Ask
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {presetQuestions.map((q) => (
          <button
            key={q.text}
            onClick={() => onAsk(q.text)}
            disabled={busy}
            title={q.hint}
            className="flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-cyan-800 hover:text-cyan-300 disabled:opacity-50"
          >
            <Sparkles className="h-2.5 w-2.5 text-cyan-600" />
            {q.text}
          </button>
        ))}
      </div>
    </div>
  );
}
