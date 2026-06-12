# Automation

The recommended automation model is:

```text
cron
  -> starts Paperclip, OpenClaw, Codex, or another AI agent
  -> agent runs deterministic report commands
  -> agent reviews outputs and diffs
  -> agent runs tests
  -> agent commits and pushes only when clean
```

The data fetch, calculations, valuation ranges, source packets, and baseline reports should be deterministic software output. The AI agent should act as the operator and reviewer: compare changes, inspect failed runs, improve narrative quality when needed, and decide whether generated artifacts are safe to commit.

## Commands

Run every enabled supported security in `config/watchlist.json`:

```bash
npm run reports:watchlist
```

Preview what would run without calling providers:

```bash
npm run reports:watchlist -- --dry-run
```

Run selected securities by `EXCHANGE:TICKER`, ticker, or watchlist id:

```bash
npm run reports:watchlist -- --symbols NASDAQ:NVDA NVDA_NASDAQ
```

## Local Cron Example

Example cron entry for a daily 07:30 run. Replace the agent command with the Paperclip/OpenClaw/Codex invocation you use locally.

```cron
30 7 * * * cd /path/to/Stock-Analyzer-Watchlist && paperclip "Run the scheduled stock report workflow from AGENTS.md"
```

## Agent Prompt

Use a prompt like this for Paperclip, OpenClaw, Codex, or another local agent:

```text
Run the scheduled stock report workflow.

1. Read AGENTS.md.
2. Run npm ci if dependencies are missing.
3. Run npm run reports:watchlist.
4. Inspect data/runs/latest.json.
5. Run npm test.
6. If tests pass and there are meaningful generated report/source changes, commit with a clear message and push.
7. Never print or commit .env values.
```

## Run Summary

Each non-dry run writes:

```text
data/runs/latest.json
```

The file is intentionally machine-readable so agents can quickly detect completed, failed, skipped, and planned securities.
