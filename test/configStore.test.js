const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createEmptyWatchlist,
  loadWatchlist,
  addSecurity,
  removeSecurity,
  getProviderStatus,
} = require('../src/configStore');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-store-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}

test('loadWatchlist returns an empty v1 config when the file is missing', () => {
  const projectDir = tempProject();
  assert.deepEqual(loadWatchlist(projectDir), createEmptyWatchlist());
});

test('addSecurity normalizes identifiers and creates a stable ticker MIC id', () => {
  const projectDir = tempProject();
  const added = addSecurity(projectDir, {
    name: 'Example Holding ASA',
    report_profile: 'holding_company',
    identifiers: {
      isin: 'no0012345678',
      mic: 'xosl',
      local_ticker: 'exm',
      currency: 'nok',
    },
  });

  assert.equal(added.id, 'EXM_XOSL');
  assert.equal(added.identifiers.isin, 'NO0012345678');
  assert.equal(added.identifiers.mic, 'XOSL');
  assert.equal(added.identifiers.euronext_product_id, 'NO0012345678-XOSL');
  assert.equal(added.identifiers.currency, 'NOK');
  assert.equal(added.validation_status, 'pending_validation');

  const saved = loadWatchlist(projectDir);
  assert.equal(saved.securities.length, 1);
  assert.equal(saved.securities[0].id, 'EXM_XOSL');
});

test('addSecurity rejects duplicate generated ids', () => {
  const projectDir = tempProject();
  const input = {
    name: 'Example Holding ASA',
    identifiers: { isin: 'NO0012345678', mic: 'XOSL', local_ticker: 'EXM' },
  };

  addSecurity(projectDir, input);

  assert.throws(() => addSecurity(projectDir, input), /Security already exists: EXM_XOSL/);
});

test('removeSecurity removes only the selected security', () => {
  const projectDir = tempProject();
  addSecurity(projectDir, {
    name: 'Example Holding ASA',
    identifiers: { isin: 'NO0012345678', mic: 'XOSL', local_ticker: 'EXM' },
  });
  addSecurity(projectDir, {
    name: 'EQT AB',
    identifiers: { isin: 'SE0012853455', mic: 'XSTO', local_ticker: 'EQT' },
  });

  const removed = removeSecurity(projectDir, 'EXM_XOSL');

  assert.equal(removed.id, 'EXM_XOSL');
  const saved = loadWatchlist(projectDir);
  assert.deepEqual(saved.securities.map((security) => security.id), ['EQT_XSTO']);
});

test('getProviderStatus reports only whether keys are present', () => {
  const status = getProviderStatus({
    FMP_API_KEY: 'set',
    ALPHAVANTAGE_API_KEY: '',
    MASSIVE_API_KEY: 'set',
  });

  assert.deepEqual(status, {
    fmp: true,
    alpha_vantage: false,
    massive: true,
  });
});
