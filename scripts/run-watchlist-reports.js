#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_DIR = path.join(__dirname, '..');
const WATCHLIST_PATH = path.join('config', 'watchlist.json');
const SUMMARY_PATH = path.join('data', 'runs', 'latest.json');

const MIC_TO_EXCHANGE = {
  XNAS: 'NASDAQ',
  XNYS: 'NYSE',
  XETR: 'XETRA',
};

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeUpper(value) {
  return normalizeText(value).toUpperCase();
}

function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    symbols: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--symbols') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) {
        options.symbols.push(argv[index + 1]);
        index += 1;
      }
      continue;
    }

    if (!arg.startsWith('--')) {
      options.symbols.push(arg);
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  options.symbols = options.symbols.map(normalizeUpper).filter(Boolean);
  return options;
}

function matchesRequestedSymbol(security, input, requestedSymbols) {
  if (!requestedSymbols.length) return true;
  const ticker = normalizeUpper(security && security.identifiers && security.identifiers.local_ticker);
  const id = normalizeUpper(security && security.id);
  const normalizedInput = normalizeUpper(input);
  return requestedSymbols.some((symbol) => (
    symbol === id || symbol === ticker || symbol === normalizedInput
  ));
}

function symbolInputsFromWatchlist(watchlist, options = {}) {
  const requestedSymbols = (options.symbols || []).map(normalizeUpper).filter(Boolean);
  const inputs = [];
  const skipped = [];

  for (const security of watchlist.securities || []) {
    const id = normalizeUpper(security && security.id) || 'UNKNOWN_SECURITY';
    const name = normalizeText(security && security.name) || id;
    const identifiers = security && security.identifiers || {};
    const ticker = normalizeUpper(identifiers.local_ticker);
    const mic = normalizeUpper(identifiers.mic);
    const exchange = MIC_TO_EXCHANGE[mic];
    const input = exchange && ticker ? `${exchange}:${ticker}` : null;

    if (!matchesRequestedSymbol(security, input, requestedSymbols)) continue;

    if (security.enabled === false) {
      skipped.push({ id, name, reason: 'disabled' });
      continue;
    }

    if (!ticker) {
      skipped.push({ id, name, reason: 'missing_ticker' });
      continue;
    }

    if (!exchange) {
      skipped.push({ id, name, reason: 'unsupported_mic', mic: mic || null });
      continue;
    }

    inputs.push({ id, name, input, ticker, mic, exchange });
  }

  return { inputs, skipped };
}

function readWatchlist(projectDir) {
  const filePath = path.join(projectDir, WATCHLIST_PATH);
  if (!fs.existsSync(filePath)) return { version: 1, securities: [] };
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(projectDir, relativePath, value) {
  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function redactSecrets(value) {
  return normalizeText(value)
    .replace(/((?:api[_-]?key|apikey|token|secret|password|authorization)\s*[=:]\s*)([^\s&]+)/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, '$1[redacted]');
}

function defaultRunReport(input, projectDir) {
  const scriptPath = path.join(projectDir, 'scripts', 'add-stocks.js');
  return spawnSync(process.execPath, [scriptPath, input], {
    cwd: projectDir,
    encoding: 'utf8',
  });
}

function parseReportOutput(stdout) {
  try {
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed[0] || null : parsed;
  } catch {
    return null;
  }
}

function summarizeTotals(results) {
  return results.reduce((totals, result) => {
    totals[result.status] = (totals[result.status] || 0) + 1;
    return totals;
  }, {
    planned: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
  });
}

function runWatchlistReports({
  projectDir = PROJECT_DIR,
  argv = process.argv.slice(2),
  runReport = defaultRunReport,
} = {}) {
  const options = parseArgs(argv);
  const startedAt = new Date().toISOString();
  const watchlist = readWatchlist(projectDir);
  const plan = symbolInputsFromWatchlist(watchlist, { symbols: options.symbols });

  const results = [
    ...plan.skipped.map((item) => ({
      ...item,
      input: null,
      status: 'skipped',
    })),
  ];

  for (const item of plan.inputs) {
    if (options.dryRun) {
      results.push({
        id: item.id,
        name: item.name,
        input: item.input,
        status: 'planned',
      });
      continue;
    }

    const child = runReport(item.input, projectDir);
    const status = Number.isInteger(child.status) ? child.status : 1;
    const reportOutput = parseReportOutput(child.stdout);

    if (status === 0 && reportOutput) {
      results.push({
        id: item.id,
        name: item.name,
        input: item.input,
        status: 'completed',
        report: reportOutput.report || null,
        source_packet: reportOutput.source_packet || null,
        stance: reportOutput.stance || null,
      });
      continue;
    }

    results.push({
      id: item.id,
      name: item.name,
      input: item.input,
      status: 'failed',
      error: redactSecrets(child.stderr || child.stdout || `Report command exited with status ${status}`),
    });
  }

  const summary = {
    run_id: startedAt.replace(/[:.]/g, '-'),
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    dry_run: options.dryRun,
    requested_symbols: options.symbols,
    summary_path: options.dryRun ? null : SUMMARY_PATH,
    totals: summarizeTotals(results),
    results,
  };

  if (!options.dryRun) writeJson(projectDir, SUMMARY_PATH, summary);
  return summary;
}

function main() {
  const summary = runWatchlistReports();
  console.log(JSON.stringify(summary, null, 2));
  if (summary.totals.failed > 0) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(redactSecrets(error.stack || error.message));
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  redactSecrets,
  runWatchlistReports,
  symbolInputsFromWatchlist,
};
