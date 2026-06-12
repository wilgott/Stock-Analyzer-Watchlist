const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildSourcePacket,
  generateReport,
  loadAnalysisPolicy,
  netDebtFromBalance,
  ttmMetricFromQuarterRows,
} = require('../scripts/add-stocks');

const root = path.join(__dirname, '..');

function baseSecurity(overrides = {}) {
  return {
    input: {
      id: 'TEST_NASDAQ',
      ticker: 'TEST',
      slug: 'test-nasdaq',
    },
    symbol: 'TEST',
    identifiers: {
      ticker: 'TEST',
      mic: 'XNAS',
      isin: 'US0000000000',
      currency: 'USD',
      provider_symbol: 'TEST',
    },
    company: {
      name: 'Test Semiconductor Corp.',
      sector: 'Technology',
      industry: 'Semiconductors',
    },
    market: {
      price: 100,
      market_cap: 1_000_000_000,
      shares_outstanding: 10_000_000,
    },
    financials: {
      source: 'provider_statements',
      ttm_free_cash_flow: 80_000_000,
      ttm_net_income: 70_000_000,
      net_debt: 0,
      ttm_quality: {
        ttm_free_cash_flow: { valid: true, count: 4 },
        ttm_net_income: { valid: true, count: 4 },
      },
    },
    endpoints: {},
    sec: {
      recent_filings: [],
    },
    ...overrides,
  };
}

test('ttmMetricFromQuarterRows requires four numeric quarters with unique dates', () => {
  const complete = [
    { date: '2026-03-31', freeCashFlow: 10 },
    { date: '2025-12-31', freeCashFlow: 20 },
    { date: '2025-09-30', freeCashFlow: 30 },
    { date: '2025-06-30', freeCashFlow: 40 },
  ];

  assert.deepEqual(ttmMetricFromQuarterRows(complete, 'freeCashFlow'), {
    value: 100,
    valid: true,
    count: 4,
    dates: ['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30'],
  });
  assert.equal(ttmMetricFromQuarterRows(complete.slice(0, 3), 'freeCashFlow').valid, false);
  assert.equal(ttmMetricFromQuarterRows([
    ...complete.slice(0, 3),
    { date: '2025-06-30', freeCashFlow: null },
  ], 'freeCashFlow').valid, false);
  assert.equal(ttmMetricFromQuarterRows([
    complete[0],
    complete[1],
    complete[2],
    { date: '2025-09-30', freeCashFlow: 40 },
  ], 'freeCashFlow').valid, false);
});

test('netDebtFromBalance does not treat missing balance sheet data as zero', () => {
  assert.equal(netDebtFromBalance({ totalDebt: 100, cashAndShortTermInvestments: 40 }), 60);
  assert.equal(netDebtFromBalance({ netDebt: -25 }), -25);
  assert.equal(netDebtFromBalance({ totalDebt: 100 }), null);
  assert.equal(netDebtFromBalance({ cashAndShortTermInvestments: 40 }), null);
  assert.equal(netDebtFromBalance({}), null);
});

test('generateReport monitors instead of valuing when net debt or TTM quality is incomplete', () => {
  assert.equal(generateReport(baseSecurity({
    financials: {
      ...baseSecurity().financials,
      net_debt: null,
    },
  })).analysis.mode, 'monitor');

  assert.equal(generateReport(baseSecurity({
    financials: {
      ...baseSecurity().financials,
      ttm_quality: {
        ttm_free_cash_flow: { valid: false, count: 3 },
        ttm_net_income: { valid: true, count: 4 },
      },
    },
  })).analysis.metricName, 'ttm_net_income');

  assert.equal(generateReport(baseSecurity({
    financials: {
      ...baseSecurity().financials,
      ttm_quality: {
        ttm_free_cash_flow: { valid: false, count: 3 },
        ttm_net_income: { valid: false, count: 3 },
      },
    },
  })).analysis.mode, 'monitor');
});

test('source packet includes reproducible valuation inputs when a report is valued', () => {
  const security = baseSecurity();
  const report = generateReport(security);
  const packet = buildSourcePacket(security, report);
  const analysisModel = packet.securities[0].analysis_model;

  assert.equal(report.analysis.mode, 'valued');
  assert.equal(analysisModel.valuation_inputs.metric_name, report.analysis.metricName);
  assert.equal(analysisModel.valuation_inputs.metric_value, security.financials[report.analysis.metricName]);
  assert.equal(analysisModel.valuation_inputs.shares_outstanding, security.market.shares_outstanding);
  assert.equal(analysisModel.valuation_inputs.net_debt, security.financials.net_debt);
  assert.deepEqual(analysisModel.valuation_inputs.multiples, report.analysis.multiples);
  assert.deepEqual(analysisModel.recommendation_policy, report.analysis.recommendationPolicy);
  assert.ok(analysisModel.valuation_scenarios.base_low.fair_value_per_share);
});

test('analysis policy is configurable and drives buy threshold decisions', () => {
  const defaultPolicy = loadAnalysisPolicy(root);
  const defaultReport = generateReport(baseSecurity({
    market: {
      price: 100,
      market_cap: 1_000_000_000,
      shares_outstanding: 30_000_000,
    },
  }), defaultPolicy);

  assert.equal(defaultPolicy.buy_min_base_low_upside_pct, 8);
  assert.equal(defaultReport.analysis.stance, 'Buy');
  assert.equal(defaultReport.analysis.recommendationPolicy.buy_min_base_low_upside_pct, 8);

  const conservativeReport = generateReport(baseSecurity({
    market: {
      price: 100,
      market_cap: 1_000_000_000,
      shares_outstanding: 30_000_000,
    },
  }), {
    ...defaultPolicy,
    buy_min_base_low_upside_pct: 25,
  });

  assert.equal(conservativeReport.analysis.stance, 'Hold / Accumulate on Pullbacks');
  assert.equal(conservativeReport.analysis.recommendationPolicy.buy_min_base_low_upside_pct, 25);
});

test('checked-in Nvidia source packet stance matches its own configurable threshold policy', () => {
  const packet = JSON.parse(fs.readFileSync(path.join(root, 'data/source-packets/2026-06-12-nvda-nasdaq.json'), 'utf8'));
  const security = packet.securities[0];
  const analysis = security.analysis_model;
  const policy = analysis.recommendation_policy;
  const lowUpside = Number(analysis.base_upside_low_pct);
  const highUpside = Number(analysis.base_upside_high_pct);

  assert.ok(policy);
  assert.ok(Number.isFinite(lowUpside));
  assert.ok(Number.isFinite(highUpside));

  if (lowUpside >= policy.buy_min_base_low_upside_pct) {
    assert.equal(analysis.stance, 'Buy');
  } else if (highUpside <= policy.sell_max_base_high_upside_pct) {
    assert.equal(analysis.stance, 'Sell / Trim');
  } else if (highUpside >= policy.accumulate_min_base_high_upside_pct) {
    assert.equal(analysis.stance, 'Hold / Accumulate on Pullbacks');
  } else {
    assert.equal(analysis.stance, 'Hold');
  }
});
