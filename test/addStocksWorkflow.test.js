const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseSymbolInput, reportFileBase } = require('../scripts/add-stocks');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('project exposes a reusable add-stocks workflow', () => {
  const packageJson = JSON.parse(read('package.json'));
  const readme = read('README.md');
  const script = read('scripts/add-stocks.js');

  assert.equal(packageJson.scripts['add-stocks'], 'node scripts/add-stocks.js');
  assert.match(readme, /npm run add-stocks -- NASDAQ:NVDA/);
  assert.match(script, /parseSymbolInput/);
  assert.match(script, /generateReport/);
  assert.match(script, /saveSourcePacket/);
  assert.match(script, /updateWatchlist/);
});

test('parseSymbolInput normalizes supported exchange ticker inputs', () => {
  assert.equal(parseSymbolInput('NASDAQ:NVDA').id, 'NVDA_NASDAQ');
  assert.equal(parseSymbolInput('nasdaq:nvda').fmpSymbol, 'NVDA');
});

test('reportFileBase includes a timestamp run id to avoid overwriting report history', () => {
  const input = parseSymbolInput('NASDAQ:NVDA');

  assert.equal(reportFileBase(input, '2026-06-12-193012'), '2026-06-12-193012-nvda-nasdaq');
});
