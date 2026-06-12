const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function loadWatchlistClient() {
  const nodes = {
    '#add-security-form': { addEventListener() {} },
    '#refresh-button': { addEventListener() {} },
    '#watchlist-body': { addEventListener() {}, innerHTML: '' },
    '#provider-status': { innerHTML: '' },
    '#empty-row-template': { innerHTML: '<tr><td colspan="8" class="empty-state">No stocks configured yet.</td></tr>' },
    '#form-message': { textContent: '', classList: { toggle() {} } },
    'details.add-card': { addEventListener() {}, open: false },
    '.summary-action': { textContent: '' },
  };
  const context = {
    document: {
      querySelector(selector) {
        return nodes[selector] || null;
      },
    },
    fetch: async (url) => ({
      ok: true,
      json: async () => (String(url).includes('provider-status')
        ? { fmp: false, alpha_vantage: false, massive: false }
        : { securities: [] }),
    }),
    FormData,
    window: { location: { href: '' } },
  };

  vm.createContext(context);
  const source = `${fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8')}
globalThis.__securityRow = securityRow;`;
  vm.runInContext(source, context);
  return context;
}

test('watchlist row escapes user-controlled security fields', () => {
  const context = loadWatchlistClient();
  const row = context.__securityRow({
    id: 'UNSAFE_TEST',
    name: '<img src=x onerror="window.__xss=1">Unsafe Co',
    report_profile: '<script>window.__profile=1</script>',
    identifiers: {
      isin: 'XX0000000000',
      mic: '<svg onload="window.__mic=1"></svg>',
      local_ticker: 'BAD',
    },
    validation_status: '<svg onload="window.__status=1"></svg>',
    recommendation: {
      label: '<img src=x onerror="window.__rec=1">',
      tone: 'buy',
    },
    last_report_path: null,
  });

  assert.doesNotMatch(row, /<img/i);
  assert.doesNotMatch(row, /<script/i);
  assert.doesNotMatch(row, /<svg/i);
  assert.match(row, /&lt;img/);
  assert.match(row, /&lt;script/);
  assert.match(row, /data-label="Company"/);
  assert.match(row, /data-label="Recommendation"/);
});

test('watchlist stylesheet has a mobile card layout for security rows', () => {
  const css = fs.readFileSync(path.join(root, 'public/assets/styles.css'), 'utf8');

  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.security-row\s*\{/);
  assert.match(css, /td::before\s*\{/);
  assert.match(css, /content: attr\(data-label\)/);
  assert.match(css, /table,\s*\n\s*tbody\s*\{\s*\n\s*display: block;/);
  assert.match(css, /\.security-row td\s*\{[\s\S]*min-width: 0;/);
  assert.match(css, /\.pill\s*\{[\s\S]*overflow-wrap: anywhere;/);
  assert.match(css, /\.hero > \*,\s*\n\s*\.detail-grid > \*\s*\{\s*\n\s*min-width: 0;/);
});
