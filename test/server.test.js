const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createServer } = require('../src/server');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-server-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
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

async function requestJson(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  return { response, body };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test('GET /api/securities returns the watchlist config', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/securities');

    assert.equal(response.status, 200);
    assert.deepEqual(body, { version: 1, securities: [] });
  });
});

test('GET /api/securities includes latest report recommendation when a source packet exists', async () => {
  const projectDir = tempProject();
  writeJson(path.join(projectDir, 'config', 'watchlist.json'), {
    version: 1,
    securities: [{
      id: 'SELL_EXAMPLE_XNAS',
      name: 'Sell Example Corp.',
      enabled: true,
      report_profile: 'general_equity',
      identifiers: {
        isin: 'US0000000001',
        mic: 'XNAS',
        local_ticker: 'SELL',
        currency: 'USD',
      },
      provider_symbols: {},
      validation_status: 'provider_verified_internal_draft_report',
      last_report_path: 'reports/2026-06-12-sell-example-report.html',
    }, {
      id: 'MONITOR_EXAMPLE_XNAS',
      name: 'Monitor Example Corp.',
      enabled: true,
      report_profile: 'monitor_report',
      identifiers: {
        isin: 'US0000000002',
        mic: 'XNAS',
        local_ticker: 'MON',
        currency: 'USD',
      },
      provider_symbols: {},
      validation_status: 'provider_verified_monitor_only',
      last_report_path: 'reports/2026-06-12-monitor-example-report.html',
    }],
  });
  writeJson(path.join(projectDir, 'data', 'source-packets', '2026-06-12-sell-example.json'), {
    securities: [{
      security_id: 'SELL_EXAMPLE_XNAS',
      analysis_model: {
        stance: 'Sell / Trim',
        horizon: '12-18 months',
        confidence: 'Medium-Low',
      },
    }],
  });
  writeJson(path.join(projectDir, 'data', 'source-packets', '2026-06-12-monitor-example.json'), {
    securities: [{
      security_id: 'MONITOR_EXAMPLE_XNAS',
      analysis_model: {
        stance: 'No Model Stance',
        horizon: 'Monitor until source-backed fundamentals are available',
        confidence: 'Low',
      },
    }],
  });

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/securities');

    assert.equal(response.status, 200);
    assert.deepEqual(body.securities.map((security) => security.recommendation), [{
      label: 'Sell',
      raw_stance: 'Sell / Trim',
      tone: 'sell',
    }, {
      label: 'Monitor',
      raw_stance: 'No Model Stance',
      tone: 'monitor',
    }]);
  });
});

test('GET /api/securities does not infer buy from ambiguous recommendation text', async () => {
  const projectDir = tempProject();
  writeJson(path.join(projectDir, 'config', 'watchlist.json'), {
    version: 1,
    securities: [{
      id: 'AMBIGUOUS_XNAS',
      name: 'Ambiguous Example Corp.',
      enabled: true,
      report_profile: 'general_equity',
      identifiers: {
        isin: 'US0000000003',
        mic: 'XNAS',
        local_ticker: 'AMB',
        currency: 'USD',
      },
      provider_symbols: {},
      validation_status: 'provider_verified_internal_draft_report',
      last_report_path: 'reports/2026-06-12-ambiguous-report.html',
    }],
  });
  writeJson(path.join(projectDir, 'data', 'source-packets', '2026-06-12-ambiguous.json'), {
    securities: [{
      security_id: 'AMBIGUOUS_XNAS',
      analysis_model: {
        stance: 'not a buy',
      },
    }],
  });

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/securities');

    assert.equal(response.status, 200);
    assert.deepEqual(body.securities[0].recommendation, {
      label: 'not a buy',
      raw_stance: 'not a buy',
      tone: 'neutral',
    });
  });
});

test('GET /api/securities/:id/reports returns report history newest first', async () => {
  const projectDir = tempProject();
  writeJson(path.join(projectDir, 'config', 'watchlist.json'), {
    version: 1,
    securities: [{
      id: 'NVDA_NASDAQ',
      name: 'NVIDIA Corporation',
      enabled: true,
      report_profile: 'general_equity',
      identifiers: {
        isin: 'US67066G1040',
        mic: 'XNAS',
        local_ticker: 'NVDA',
        currency: 'USD',
      },
      provider_symbols: {
        fmp: 'NVDA',
        alpha_vantage: 'NVDA',
        massive: 'NVDA',
      },
      validation_status: 'provider_sec_verified_internal_draft_report',
      last_report_path: 'reports/2026-06-12-193012-nvda-nasdaq-report.html',
    }],
  });
  for (const [base, generatedAt, stance, price, fairRange] of [
    ['2026-06-12-193012-nvda-nasdaq', '2026-06-12T19:30:12.000Z', 'Buy', 205.11, [224, 278]],
    ['2026-06-11-081500-nvda-nasdaq', '2026-06-11T08:15:00.000Z', 'Hold', 198.5, [190, 220]],
  ]) {
    writeJson(path.join(projectDir, 'data', 'source-packets', `${base}.json`), {
      generated_at: generatedAt,
      securities: [{
        security_id: 'NVDA_NASDAQ',
        analysis_model: {
          stance,
          horizon: '12-18 months',
          confidence: 'Medium-Low',
          readiness_label: 'Internal research draft',
        },
        metrics: [{
          metric_id: 'current_share_price',
          normalized_value: price,
          currency: 'USD',
        }, {
          metric_id: 'base_fair_value_range',
          normalized_value: fairRange,
          currency: 'USD',
        }],
      }],
    });
    fs.mkdirSync(path.join(projectDir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'reports', `${base}-report.html`), '<html></html>');
    fs.writeFileSync(path.join(projectDir, 'reports', `${base}-report.md`), '# Report');
  }

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/securities/NVDA_NASDAQ/reports');

    assert.equal(response.status, 200);
    assert.equal(body.security.id, 'NVDA_NASDAQ');
    assert.deepEqual(body.reports.map((report) => report.id), [
      '2026-06-12-193012-nvda-nasdaq',
      '2026-06-11-081500-nvda-nasdaq',
    ]);
    assert.deepEqual(body.reports[0].recommendation, {
      label: 'Buy',
      raw_stance: 'Buy',
      tone: 'buy',
    });
    assert.equal(body.reports[0].report_path, 'reports/2026-06-12-193012-nvda-nasdaq-report.html');
    assert.equal(body.reports[0].source_packet_path, 'data/source-packets/2026-06-12-193012-nvda-nasdaq.json');
    assert.equal(body.reports[0].current_price, 205.11);
    assert.deepEqual(body.reports[0].fair_value_range, [224, 278]);
  });
});

test('POST, GET, and DELETE /api/securities manage securities', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir }, async (baseUrl) => {
    const createResult = await requestJson(baseUrl, '/api/securities', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Example Holding ASA',
        report_profile: 'holding_company',
        identifiers: {
          isin: 'no0012345678',
          mic: 'xosl',
          local_ticker: 'exm',
          currency: 'nok',
        },
      }),
    });

    assert.equal(createResult.response.status, 201);
    assert.equal(createResult.body.id, 'EXM_XOSL');

    const getResult = await requestJson(baseUrl, '/api/securities/EXM_XOSL');
    assert.equal(getResult.response.status, 200);
    assert.equal(getResult.body.name, 'Example Holding ASA');
    assert.equal(getResult.body.identifiers.euronext_product_id, 'NO0012345678-XOSL');

    const deleteResult = await requestJson(baseUrl, '/api/securities/EXM_XOSL', {
      method: 'DELETE',
    });
    assert.equal(deleteResult.response.status, 200);
    assert.equal(deleteResult.body.id, 'EXM_XOSL');

    const listResult = await requestJson(baseUrl, '/api/securities');
    assert.deepEqual(listResult.body.securities, []);
  });
});

test('POST /api/securities returns validation errors as 400', async () => {
  const projectDir = tempProject();

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/securities', {
      method: 'POST',
      body: JSON.stringify({ name: 'Missing identifiers' }),
    });

    assert.equal(response.status, 400);
    assert.match(body.error, /Security requires an ISIN/);
  });
});

test('GET /api/provider-status reports booleans without credential values', async () => {
  const projectDir = tempProject();

  await withServer({
    projectDir,
    env: {
      FMP_API_KEY: 'set',
      ALPHAVANTAGE_API_KEY: '',
      MASSIVE_API_KEY: 'set',
    },
  }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/provider-status');

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      fmp: true,
      alpha_vantage: false,
      massive: true,
    });
    assert.equal(JSON.stringify(body).includes('set'), false);
  });
});

test('GET /api/provider-status loads keys from project .env by default', async () => {
  const projectDir = tempProject();
  fs.writeFileSync(path.join(projectDir, '.env'), [
    'FMP_API_KEY=set',
    'ALPHAVANTAGE_API_KEY=set',
    'MASSIVE_API_KEY=',
    '',
  ].join('\n'));

  await withServer({ projectDir }, async (baseUrl) => {
    const { response, body } = await requestJson(baseUrl, '/api/provider-status');

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      fmp: true,
      alpha_vantage: true,
      massive: false,
    });
    assert.equal(JSON.stringify(body).includes('set'), false);
  });
});
