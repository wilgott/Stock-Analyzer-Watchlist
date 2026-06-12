const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractSecCompanyFacts,
  findCikForSecEligibleInput,
  findCikFromSecTickerMap,
  mergeSecFactsIntoFinancials,
  parseSymbolInput,
} = require('../scripts/add-stocks');

function fact(units) {
  return { units: { USD: units } };
}

test('extractSecCompanyFacts builds TTM metrics from annual plus YTD comparable SEC facts', () => {
  const companyFacts = {
    facts: {
      'us-gaap': {
        Revenues: fact([
          { form: '10-Q', fy: 2025, fp: 'Q1', start: '2025-01-01', end: '2025-03-31', val: 100 },
          { form: '10-K', fy: 2025, fp: 'FY', start: '2025-01-01', end: '2025-12-31', val: 1000 },
          { form: '10-Q', fy: 2026, fp: 'Q1', start: '2026-01-01', end: '2026-03-31', val: 150 },
        ]),
        NetIncomeLoss: fact([
          { form: '10-Q', fy: 2025, fp: 'Q1', start: '2025-01-01', end: '2025-03-31', val: 10 },
          { form: '10-K', fy: 2025, fp: 'FY', start: '2025-01-01', end: '2025-12-31', val: 200 },
          { form: '10-Q', fy: 2026, fp: 'Q1', start: '2026-01-01', end: '2026-03-31', val: 30 },
        ]),
        NetCashProvidedByUsedInOperatingActivities: fact([
          { form: '10-Q', fy: 2025, fp: 'Q1', start: '2025-01-01', end: '2025-03-31', val: 40 },
          { form: '10-K', fy: 2025, fp: 'FY', start: '2025-01-01', end: '2025-12-31', val: 300 },
          { form: '10-Q', fy: 2026, fp: 'Q1', start: '2026-01-01', end: '2026-03-31', val: 70 },
        ]),
        PaymentsToAcquirePropertyPlantAndEquipment: fact([
          { form: '10-Q', fy: 2025, fp: 'Q1', start: '2025-01-01', end: '2025-03-31', val: 20 },
          { form: '10-K', fy: 2025, fp: 'FY', start: '2025-01-01', end: '2025-12-31', val: 90 },
          { form: '10-Q', fy: 2026, fp: 'Q1', start: '2026-01-01', end: '2026-03-31', val: 35 },
        ]),
        CashAndCashEquivalentsAtCarryingValue: fact([
          { form: '10-K', fy: 2025, fp: 'FY', end: '2025-12-31', val: 500 },
          { form: '10-Q', fy: 2026, fp: 'Q1', end: '2026-03-31', val: 450 },
        ]),
        LongTermDebtCurrent: fact([
          { form: '10-Q', fy: 2026, fp: 'Q1', end: '2026-03-31', val: 25 },
        ]),
        LongTermDebtNoncurrent: fact([
          { form: '10-Q', fy: 2026, fp: 'Q1', end: '2026-03-31', val: 175 },
        ]),
      },
    },
  };

  const result = extractSecCompanyFacts(companyFacts);

  assert.equal(result.ttm_revenue, 1050);
  assert.equal(result.ttm_net_income, 220);
  assert.equal(result.ttm_operating_cash_flow, 330);
  assert.equal(result.ttm_capex, -105);
  assert.equal(result.ttm_free_cash_flow, 225);
  assert.equal(result.cash_and_short_term_investments, 450);
  assert.equal(result.total_debt, 200);
  assert.equal(result.net_debt, -250);
  assert.equal(result.source, 'sec_companyfacts');
});

test('mergeSecFactsIntoFinancials uses SEC facts only when provider statements are missing', () => {
  const providerFinancials = {
    quarter_count: { income: 0, balance: 0, cashflow: 0 },
    ttm_revenue: null,
    ttm_net_income: null,
    ttm_operating_cash_flow: null,
    ttm_capex: null,
    ttm_free_cash_flow: null,
    net_debt: 0,
  };
  const secFinancials = {
    ttm_revenue: 100,
    ttm_net_income: 20,
    ttm_operating_cash_flow: 30,
    ttm_capex: -5,
    ttm_free_cash_flow: 25,
    cash_and_short_term_investments: 50,
    total_debt: 10,
    net_debt: -40,
    source: 'sec_companyfacts',
  };

  const merged = mergeSecFactsIntoFinancials(providerFinancials, secFinancials);

  assert.equal(merged.ttm_free_cash_flow, 25);
  assert.equal(merged.net_debt, -40);
  assert.equal(merged.source, 'sec_companyfacts');
});

test('findCikFromSecTickerMap returns zero-padded CIKs for exact ticker matches only', () => {
  const tickerMap = {
    0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA Corporation' },
    1: { cik_str: 1234567, ticker: 'ABCD', title: 'Example Corporation' },
  };

  assert.equal(findCikFromSecTickerMap(tickerMap, 'NVDA'), '0001045810');
  assert.equal(findCikFromSecTickerMap(tickerMap, 'nvda'), '0001045810');
  assert.equal(findCikFromSecTickerMap(tickerMap, 'NVDAX'), null);
});

test('findCikForSecEligibleInput ignores non-US exchange ticker collisions', () => {
  const tickerMap = {
    0: { cik_str: 1234567, ticker: 'ABC', title: 'Example Corporation' },
  };

  assert.equal(findCikForSecEligibleInput(parseSymbolInput('XETRA:ABC'), tickerMap), null);
  assert.equal(findCikForSecEligibleInput(parseSymbolInput('NYSE:ABC'), tickerMap), '0001234567');
});
