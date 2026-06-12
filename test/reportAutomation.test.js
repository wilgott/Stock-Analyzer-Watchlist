const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runWatchlistReports,
  symbolInputsFromWatchlist,
} = require('../scripts/run-watchlist-reports');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject(watchlist) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-runner-'));
  writeJson(path.join(dir, 'config/watchlist.json'), watchlist);
  return dir;
}

test('project exposes an agent-friendly watchlist report workflow', () => {
  const packageJson = JSON.parse(read('package.json'));
  const agents = read('AGENTS.md');
  const automation = read('docs/automation.md');

  assert.equal(packageJson.scripts['reports:watchlist'], 'node scripts/run-watchlist-reports.js');
  assert.match(agents, /npm run reports:watchlist/);
  assert.match(agents, /Do not print or commit .env values/);
  assert.match(automation, /cron/i);
  assert.match(automation, /Paperclip|OpenClaw|Codex/);
});

test('symbolInputsFromWatchlist converts enabled supported securities and reports skips', () => {
  const watchlist = {
    version: 1,
    securities: [
      {
        id: 'NVDA_NASDAQ',
        name: 'NVIDIA Corporation',
        enabled: true,
        identifiers: { mic: 'XNAS', local_ticker: 'NVDA' },
      },
      {
        id: 'SIE_XETRA',
        name: 'Siemens AG',
        enabled: true,
        identifiers: { mic: 'XETR', local_ticker: 'SIE' },
      },
      {
        id: 'DISABLED_NYSE',
        name: 'Disabled Co',
        enabled: false,
        identifiers: { mic: 'XNYS', local_ticker: 'OFF' },
      },
      {
        id: 'UNKNOWN_MIC',
        name: 'Unsupported Co',
        enabled: true,
        identifiers: { mic: 'XLON', local_ticker: 'VOD' },
      },
      {
        id: 'MISSING_TICKER',
        name: 'Missing Ticker Co',
        enabled: true,
        identifiers: { mic: 'XNAS' },
      },
    ],
  };

  const plan = symbolInputsFromWatchlist(watchlist);

  assert.deepEqual(plan.inputs.map((item) => item.input), ['NASDAQ:NVDA', 'XETRA:SIE']);
  assert.deepEqual(plan.skipped.map((item) => [item.id, item.reason]), [
    ['DISABLED_NYSE', 'disabled'],
    ['UNKNOWN_MIC', 'unsupported_mic'],
    ['MISSING_TICKER', 'missing_ticker'],
  ]);
});

test('runWatchlistReports dry-run creates a parseable summary without running providers', () => {
  const projectDir = makeProject({
    version: 1,
    securities: [
      {
        id: 'NVDA_NASDAQ',
        name: 'NVIDIA Corporation',
        enabled: true,
        identifiers: { mic: 'XNAS', local_ticker: 'NVDA' },
      },
    ],
  });

  const summary = runWatchlistReports({
    projectDir,
    argv: ['--dry-run'],
    runReport() {
      throw new Error('dry-run must not call providers');
    },
  });

  assert.equal(summary.dry_run, true);
  assert.equal(summary.results[0].status, 'planned');
  assert.equal(summary.results[0].input, 'NASDAQ:NVDA');
  assert.equal(summary.totals.planned, 1);
  assert.equal(summary.summary_path, null);
  assert.equal(fs.existsSync(path.join(projectDir, 'data/runs/latest.json')), false);
});

test('runWatchlistReports writes latest summary and redacts failed provider output', () => {
  const projectDir = makeProject({
    version: 1,
    securities: [
      {
        id: 'NVDA_NASDAQ',
        name: 'NVIDIA Corporation',
        enabled: true,
        identifiers: { mic: 'XNAS', local_ticker: 'NVDA' },
      },
      {
        id: 'FAIL_NYSE',
        name: 'Failure Example',
        enabled: true,
        identifiers: { mic: 'XNYS', local_ticker: 'FAIL' },
      },
    ],
  });

  const summary = runWatchlistReports({
    projectDir,
    argv: [],
    runReport(input) {
      if (input === 'NASDAQ:NVDA') {
        return {
          status: 0,
          stdout: JSON.stringify([{
            id: 'NVDA_NASDAQ',
            report: 'reports/2026-06-13-nvda-nasdaq-report.html',
            source_packet: 'data/source-packets/2026-06-13-nvda-nasdaq.json',
            stance: 'Buy',
          }]),
          stderr: '',
        };
      }

      return {
        status: 1,
        stdout: '',
        stderr: 'provider rejected request with apikey=real-secret-value',
      };
    },
  });

  const latestPath = path.join(projectDir, 'data/runs/latest.json');
  const persisted = JSON.parse(fs.readFileSync(latestPath, 'utf8'));

  assert.equal(summary.summary_path, 'data/runs/latest.json');
  assert.equal(persisted.totals.completed, 1);
  assert.equal(persisted.totals.failed, 1);
  assert.equal(persisted.results[0].status, 'completed');
  assert.equal(persisted.results[0].report, 'reports/2026-06-13-nvda-nasdaq-report.html');
  assert.equal(persisted.results[1].status, 'failed');
  assert.match(persisted.results[1].error, /apikey=\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(persisted), /real-secret-value/);
});
