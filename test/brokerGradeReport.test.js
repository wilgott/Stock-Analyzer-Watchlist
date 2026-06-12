const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Nvidia report is honest about readiness gaps and next analytical work', () => {
  const report = read('reports/2026-06-12-nvda-nasdaq-report.md');
  const html = read('reports/2026-06-12-nvda-nasdaq-report.html');

  assert.match(report, /Broker Readiness/);
  assert.match(report, /Internal research draft/);
  assert.match(report, /Triangulation Plan/);
  assert.match(report, /DCF/);
  assert.match(report, /Relative valuation/);
  assert.match(report, /SOTP-if-applicable/);
  assert.match(report, /WACC x terminal-growth sensitivity/);
  assert.match(report, /Peer and consensus context/);
  assert.match(html, /Broker Readiness/);
  assert.match(html, /Internal research draft/);
  assert.match(html, /Triangulation Plan/);
});
