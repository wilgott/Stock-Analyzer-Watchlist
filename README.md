# Stock Analyzer

Local-first equity research workspace for building source-backed stock reports.

The project is intentionally lightweight: no framework, no database, and no required paid data provider. It stores a watchlist in JSON, loads provider keys from a local `.env`, and serves static research reports through a small Node.js server.

> Educational purpose only. This project is a research aid, not investment advice. It does not provide personalized recommendations, suitability assessments, or buy/sell instructions for any individual.

## What It Does

- Manage a watchlist of listed securities by ISIN, MIC, ticker, and report profile.
- Track which data-provider credentials are configured without exposing values.
- Store source packets separately from rendered reports.
- Render compact analyst-first reports with source limitations visible.
- Encode broker-grade research gates so reports distinguish internal drafts from investor-ready output.

## Quick Start

```bash
npm test
npm start
```

Open:

```text
http://127.0.0.1:4173/
```

To configure data providers:

```bash
cp .env.example .env
```

Then add any keys you have to `.env`.

## Add Stocks

Use the reusable workflow instead of hand-editing the watchlist:

```bash
npm run add-stocks -- NASDAQ:NVDA
```

The command validates provider data, updates `config/watchlist.json`, writes a source packet, and renders Markdown/HTML reports. If fundamentals are missing or restricted, it creates a monitor-only report instead of forcing a valuation.

## Data sources

The app is designed to combine multiple source types:

- Official issuer reports and investor-relations materials.
- Official exchange pages and notices.
- SEC or equivalent regulatory filings.
- Financial Modeling Prep, Alpha Vantage, and Massive/Polygon when keys are configured.
- Yahoo Finance or similar public sources only as secondary context.

The report pipeline should never treat secondary data as institutional-grade evidence without reconciliation.

## Broker-grade roadmap

The current reports are useful internal drafts. Do not label a report CEO-ready or investor-ready until it passes these broker-grade gates:

- Triangulated valuation: DCF, relative valuation, and SOTP-if-applicable.
- WACC x terminal-growth sensitivity.
- Peer and consensus context.
- Variant view versus what the market appears to price.
- Source-quality and filing reconciliation.
- Change reasoning versus prior reports.

## Project Structure

```text
config/                 Watchlist
data/source-packets/    Structured source evidence used by reports
public/                 Local watchlist UI
reports/                Rendered HTML and Markdown reports
scripts/                Report-generation workflow
src/                    Node.js server and config store
test/                   Node test suite
```

## Safety Model

- `.env` is ignored by git.
- Provider status endpoints return booleans only, never key values.
- The app and reports must state that outputs are for educational purpose only and are not investment advice.
- Reports must show source limitations and confidence caps.
- Reports must not be labeled CEO-ready or investor-ready until broker-grade gates pass.

## License

MIT
