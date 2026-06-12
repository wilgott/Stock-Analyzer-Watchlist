# Agent Operating Guide

This repository is designed so an AI agent can operate the research workflow without becoming the hidden calculation engine.

## Scheduled Report Run

Use this command for cron-triggered or agent-triggered report refreshes:

```bash
npm run reports:watchlist
```

The command reads `config/watchlist.json`, re-runs enabled supported securities, updates report artifacts, and writes `data/runs/latest.json`.

Useful variants:

```bash
npm run reports:watchlist -- --dry-run
npm run reports:watchlist -- --symbols NASDAQ:NVDA NVDA_NASDAQ
```

## Agent Responsibilities

- Run `npm ci` when dependencies are not installed.
- Run `npm run reports:watchlist`.
- Inspect `data/runs/latest.json` before editing or committing.
- Run `npm test` after reports are generated.
- Commit generated reports/source packets only when tests pass.
- Do not print or commit .env values.
- Do not treat model output as investment advice.
- Keep the educational-purpose disclaimer in generated reports.

## Failure Handling

If a run partially fails, keep successful reports and inspect failed rows in `data/runs/latest.json`.
Do not retry blindly if the failure is rate limiting, missing provider coverage, or an unsupported exchange.
