const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const reportPath = path.join(__dirname, '..', 'reports', '2026-06-12-nvda-nasdaq-report.html');

test('Nvidia report includes a stable back link to the stock detail page', () => {
  const html = fs.readFileSync(reportPath, 'utf8');

  assert.match(html, /<nav class="report-nav" aria-label="Report navigation">/);
  assert.match(html, /class="back-link"/);
  assert.match(html, /href="\/stock\/NVDA_NASDAQ"/);
  assert.match(html, /aria-label="Back to NVIDIA Corporation stock detail"/);
  assert.match(html, />Back to stock</);
});

test('Nvidia report uses compact mobile hero typography', () => {
  const html = fs.readFileSync(reportPath, 'utf8');

  assert.match(html, /@media \(max-width: 820px\)/);
  assert.match(html, /h1 \{ font-size: clamp\(2\.3rem, 13vw, 4\.2rem\); line-height: 0\.92; \}/);
  assert.match(html, /\.lede \{ margin-top: 12px; font-size: 0\.96rem; \}/);
});
