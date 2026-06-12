const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServer } = require('../src/server');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-ui-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.cpSync(path.join(process.cwd(), 'public'), path.join(dir, 'public'), { recursive: true });
  return dir;
}

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('GET / serves the watchlist page', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Stock Analyzer Watchlist/);
    assert.match(body, /class="hero watchlist-hero"/);
    assert.match(body, /class="status-panel provider-compact"/);
    assert.match(body, /<details class="card add-card"/);
    assert.match(body, /<summary class="add-stock-summary"/);
    assert.match(body, /id="add-security-form"/);
    assert.match(body, /<th>Recommendation<\/th>/);
    assert.match(body, /<td colspan="8">Loading watchlist\.\.\.<\/td>/);
  });
});

test('GET /stock/:id serves the stock detail shell', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/stock/NVDA_NASDAQ`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Stock Detail/);
    assert.match(body, /id="latest-summary"/);
    assert.match(body, /id="report-history"/);
    assert.match(body, /assets\/stock.js/);
  });
});

test('GET /assets/app.js serves the watchlist app script', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/app.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /loadWatchlist/);
    assert.match(body, /recommendationPill/);
  });
});

test('GET /assets/stock.js serves the stock detail script', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/assets/stock.js`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /loadSecurity/);
    assert.match(body, /renderReportHistory/);
    assert.match(body, /fairValueBar/);
  });
});

test('GET /data/source-packets/:file serves stored source packets', async () => {
  const projectDir = tempProject();
  const packetDir = path.join(projectDir, 'data', 'source-packets');
  fs.mkdirSync(packetDir, { recursive: true });
  fs.writeFileSync(path.join(packetDir, 'sample.json'), JSON.stringify({ ok: true }), 'utf8');

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/data/source-packets/sample.json`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true });
  });
});

test('static archive routes reject traversal outside their directories', async () => {
  const projectDir = tempProject();
  fs.mkdirSync(path.join(projectDir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'data', 'source-packets'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET_SHOULD_NOT_LEAK=true\n', 'utf8');

  await withServer({ projectDir, publicDir: path.join(projectDir, 'public') }, async (baseUrl) => {
    for (const route of ['/reports/%2e%2e/.env', '/data/source-packets/%2e%2e/%2e%2e/.env']) {
      const response = await fetch(`${baseUrl}${route}`);
      const body = await response.text();

      assert.equal(response.status, 404);
      assert.doesNotMatch(body, /SECRET_SHOULD_NOT_LEAK/);
    }
  });
});
