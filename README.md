# Ask Your Data

Ask a plain-English question about your data and get SQL, a chart, and a short explanation — built as a two-system pipeline:

1. **Jev (System 1)** — TypeSafe's fast decision model. It checks whether the question is answerable from the schema at all, picks the main table, and selects the relevant columns. It is cheap, calibrated, and fast.
2. **The LLM (System 2)** — a general-purpose LLM that writes the SQL using *only* the schema slice Jev selected, then explains the results in plain English.

A TypeScript routing policy sits between them with configurable thresholds (Strict / Balanced / Loose presets). The code validates the generated SQL as read-only and executes it under a locked-down Postgres role.

## Architecture

```mermaid
flowchart TD
    A[User question] --> B[jev-route edge function]
    B --> C[TypeSafe System One API<br/>jev-1.13.0]
    C --> D[Routing policy - pure TS<br/>thresholds in code]
    D -->|refuse| E[Unanswerable notice<br/>+ missing data note]
    D -->|clarify| F[Table picker / clarifying chips]
    D -->|proceed| G[llm edge function<br/>write_sql with schema slice]
    G --> H[SQL validator - single SELECT<br/>keyword blocklist]
    H --> I[Read-only Postgres role<br/>5s timeout, 1000-row limit]
    I --> J[llm edge function<br/>explain]
    J --> K[Chart + table + explanation]
```

## Why a fast calibrated router comes first

- **Refuses unanswerable questions early.** "What's the weather in Denver?" never reaches the LLM, so it never hallucinates a plausible-looking query over unrelated tables.
- **Sends smaller prompts.** The SQL-writing LLM only sees the chosen table(s) and columns — not the entire schema. Fewer input tokens, lower cost, less noise.
- **Fewer hallucinated columns.** When the model only sees columns a calibrated router flagged as relevant, it cannot invent columns that don't exist.
- **Thresholds kept in code.** Calibration decisions live in a pure TypeScript function with sliders and presets — testable, versioned, and tunable without prompt edits.

## Safety

- **Read-only Postgres role.** Generated SQL never runs as a privileged user. The runner function is owned by a `NOLOGIN` role with only SELECT grants on the demo and uploaded data.
- **Validator.** Only a single `SELECT` or `WITH ... SELECT` statement is accepted. Chained statements (`;`) are rejected, as are write/DDL keywords (`insert`, `update`, `delete`, `drop`, `alter`, `create`, `grant`, `truncate`, `copy`, ...).
- **Statement timeout.** Each run sets `statement_timeout = 5s` so heavy queries can't block the database.
- **Row limit.** `LIMIT 1000` is appended when the user's SQL has no limit.
- **Daily call limits.** Jev and the LLM each track per-day call counters; past the limit, the functions return 429 and the UI shows a banner.

## Setup

1. Create a Supabase project.
2. Apply the migrations (demo data, app tables, read-only runner).
3. Set the secrets: `supabase secrets set TYPESAFE_API_KEY=... OPENAI_API_KEY=...`
4. Deploy the three edge functions: `data`, `jev-route`, `llm`.
5. Seed data is created automatically on first load.
6. `npm install && npm run dev`

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | yes | Supabase anon key |
| `TYPESAFE_API_KEY` | server secret | TypeSafe API key for Jev |
| `OPENAI_API_KEY` | server secret | OpenAI key for the SQL/explain LLM |
| `OPENAI_BASE_URL` | server secret (optional) | Override for OpenAI-compatible endpoints |
| `OPENAI_MODEL` | server secret (optional) | Defaults to `gpt-4o-mini` |
| `DAILY_CALL_LIMIT` | server secret (optional) | Daily per-function call cap, default 200 |

`.env.example` lists only the two Vite variables.

## Screenshots

![App overview](docs/screenshots/overview.png)

![Jev panel](docs/screenshots/jev-panel.png)

## Design decisions

- **Jev pinned to `jev-1.13.0`.** Router behavior must be stable for the policy thresholds above it to mean anything.
- **One fan-out request per question.** All routing questions (answerable, table, columns, join, ambiguous) go in a single TypeSafe call; if the payload is too big it splits into routing + column requests.
- **Thresholds in code, not prompts.** A prompt can't be unit-tested. The routing policy is a pure function, so presets and sliders are deterministic.
- **Mock LLM mode still runs Jev live.** The demo remains meaningful without an OpenAI key — routing, validation, and execution are real; only drafting/explaining are templated.
- **CSV uploads become real tables.** Parsed in the browser, typed via inference, and created under the `uploads` schema so the same read-only guard applies.
