const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('public repository documentation exists and explains safe setup', () => {
  const readme = read('README.md');
  const contributing = read('CONTRIBUTING.md');
  const security = read('SECURITY.md');
  const license = read('LICENSE');

  assert.match(readme, /Stock Analyzer/);
  assert.match(readme, /Local-first/);
  assert.match(readme, /Educational purpose only/);
  assert.match(readme, /not investment advice/i);
  assert.match(readme, /Data sources/);
  assert.match(readme, /Broker-grade roadmap/);
  assert.match(contributing, /Do not commit secrets/);
  assert.match(security, /Do not open a public issue with secrets/);
  assert.match(license, /MIT License/);
});

test('example env documents provider keys without real credentials', () => {
  const example = read('.env.example');

  assert.match(example, /FMP_API_KEY=/);
  assert.match(example, /ALPHA_VANTAGE_API_KEY=/);
  assert.match(example, /MASSIVE_API_KEY=/);
  assert.doesNotMatch(example, /[A-Za-z0-9_-]{24,}/);
});

test('package metadata is suitable for a public project', () => {
  const pkg = JSON.parse(read('package.json'));

  assert.equal(pkg.private, false);
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.description, /local-first/i);
  assert.ok(pkg.scripts.start);
  assert.ok(pkg.scripts.test);
});

test('public app and reports carry educational-purpose disclaimer', () => {
  const disclaimer = /Educational purpose only/;
  const notAdvice = /not investment advice/i;

  for (const relativePath of [
    'public/index.html',
    'public/stock.html',
    'scripts/add-stocks.js',
    'reports/2026-06-12-nvda-nasdaq-report.md',
    'reports/2026-06-12-nvda-nasdaq-report.html',
    'data/source-packets/2026-06-12-nvda-nasdaq.json',
  ]) {
    const content = read(relativePath);
    assert.match(content, disclaimer, `${relativePath} should state educational purpose only`);
    assert.match(content, notAdvice, `${relativePath} should state it is not investment advice`);
  }
});
