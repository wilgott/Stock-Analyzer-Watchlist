#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { loadProjectEnv } = require('../src/env');

const PROJECT_DIR = path.join(__dirname, '..');
const REPORT_DATE = new Date().toISOString().slice(0, 10);
const ACCESSED_AT = new Date().toISOString();
const REPORT_RUN_ID = `${REPORT_DATE}-${ACCESSED_AT.slice(11, 19).replaceAll(':', '')}`;
const SEC_USER_AGENT = 'openai-pm-stock-analyzer/0.1 contact@example.com';
const SEC_TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';

const EXCHANGES = {
  NASDAQ: { mic: 'XNAS', fmpSuffix: '', alphaSuffix: '', massive: true, currency: 'USD' },
  NYSE: { mic: 'XNYS', fmpSuffix: '', alphaSuffix: '', massive: true, currency: 'USD' },
  XETRA: { mic: 'XETR', fmpSuffix: '.DE', alphaSuffix: '.DEX', massive: false, currency: 'EUR' },
};

const KNOWN_ISINS = {
  NVDA: 'US67066G1040',
};

function parseSymbolInput(input) {
  const normalized = String(input).trim().toUpperCase();
  const match = normalized.match(/^([A-Z]+):([A-Z0-9.-]+)$/);
  if (!match || !EXCHANGES[match[1]]) {
    throw new Error(`Use EXCHANGE:TICKER, with exchange one of ${Object.keys(EXCHANGES).join(', ')}. Got: ${input}`);
  }

  const [, exchange, ticker] = match;
  const config = EXCHANGES[exchange];
  return {
    exchange,
    ticker,
    id: `${ticker.replace(/[^A-Z0-9]/g, '_')}_${exchange}`,
    slug: `${ticker.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${exchange.toLowerCase()}`,
    fmpSymbol: `${ticker}${config.fmpSuffix}`,
    alphaSymbol: `${ticker}${config.alphaSuffix}`,
    massiveSymbol: ticker,
    mic: config.mic,
    massive: config.massive,
    fallbackCurrency: config.currency,
  };
}

function reportFileBase(input, runId = REPORT_RUN_ID) {
  return `${runId}-${input.slug}`;
}

function reportPath(input, extension, runId = REPORT_RUN_ID) {
  return `reports/${reportFileBase(input, runId)}-report.${extension}`;
}

function sourcePacketPath(input, runId = REPORT_RUN_ID) {
  return `data/source-packets/${reportFileBase(input, runId)}.json`;
}

function endpointUrl(base, params, secretParam) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const redacted = url.toString();
  if (secretParam) url.searchParams.set(secretParam.key, secretParam.value || '');
  return { url, redacted };
}

async function fetchJson(name, url, redactedUrl, options = {}) {
  try {
    const response = await fetch(url, { headers: options.headers || {} });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { parse_error: true, text_sample: text.slice(0, 240) };
    }
    return { name, ok: response.ok, status: response.status, url: redactedUrl, body };
  } catch (error) {
    return { name, ok: false, status: null, url: redactedUrl, error: error.message, body: null };
  }
}

async function fetchSecTickerMap() {
  return fetchJson('sec_company_tickers', SEC_TICKER_MAP_URL, SEC_TICKER_MAP_URL, {
    headers: { 'User-Agent': SEC_USER_AGENT },
  });
}

function findCikFromSecTickerMap(tickerMap, ticker) {
  const normalizedTicker = String(ticker || '').toUpperCase();
  const row = Object.values(tickerMap || {}).find((candidate) => (
    String(candidate && candidate.ticker || '').toUpperCase() === normalizedTicker
  ));
  return row && row.cik_str ? String(row.cik_str).padStart(10, '0') : null;
}

function findCikForSecEligibleInput(input, tickerMap) {
  if (!input || !input.massive) return null;
  return findCikFromSecTickerMap(tickerMap, input.ticker);
}

function firstObject(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ttmMetricFromQuarterRows(rows, key) {
  const latestFour = firstArray(rows).slice(0, 4);
  const dates = latestFour.map((row) => row.date || row.fiscalDateEnding || row.filingDate || null);
  const values = latestFour.map((row) => numberOrNull(row[key]));
  const uniqueDates = new Set(dates.filter(Boolean));
  const valid = latestFour.length === 4
    && dates.every(Boolean)
    && uniqueDates.size === 4
    && values.every((value) => Number.isFinite(value));

  return {
    value: valid ? values.reduce((total, value) => total + value, 0) : null,
    valid,
    count: values.filter((value) => Number.isFinite(value)).length,
    dates,
  };
}

function netDebtFromBalance(balance) {
  const explicitNetDebt = numberOrNull(balance && balance.netDebt);
  if (Number.isFinite(explicitNetDebt)) return explicitNetDebt;

  const totalDebt = numberOrNull(balance && balance.totalDebt);
  const cash = numberOrNull(balance && balance.cashAndShortTermInvestments);
  if (!Number.isFinite(totalDebt) || !Number.isFinite(cash)) return null;

  return totalDebt - cash;
}

function compactFilings(secBody) {
  const recent = secBody && secBody.filings && secBody.filings.recent;
  if (!recent) return [];
  return (recent.form || []).slice(0, 8).map((form, index) => ({
    form,
    filing_date: recent.filingDate && recent.filingDate[index],
    report_date: recent.reportDate && recent.reportDate[index],
    accession_number: recent.accessionNumber && recent.accessionNumber[index],
    primary_document: recent.primaryDocument && recent.primaryDocument[index],
  }));
}

function sortByEndThenFiledDesc(a, b) {
  const endCompare = String(b.end || '').localeCompare(String(a.end || ''));
  if (endCompare) return endCompare;
  return String(b.filed || '').localeCompare(String(a.filed || ''));
}

function unitFacts(companyFacts, tag) {
  const concept = companyFacts
    && companyFacts.facts
    && companyFacts.facts['us-gaap']
    && companyFacts.facts['us-gaap'][tag];
  return concept && concept.units && Array.isArray(concept.units.USD) ? concept.units.USD : [];
}

function durationDays(fact) {
  if (!fact.start || !fact.end) return null;
  const start = new Date(fact.start);
  const end = new Date(fact.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function annualFact(facts) {
  return facts
    .filter((fact) => ['10-K', '20-F', '40-F'].includes(fact.form))
    .filter((fact) => fact.fp === 'FY' || (durationDays(fact) || 0) >= 300)
    .filter((fact) => Number.isFinite(numberOrNull(fact.val)))
    .sort(sortByEndThenFiledDesc)[0] || null;
}

function latestYtdQuarterFact(facts) {
  return facts
    .filter((fact) => fact.form === '10-Q')
    .filter((fact) => ['Q1', 'Q2', 'Q3'].includes(fact.fp))
    .filter((fact) => fact.start && fact.end)
    .filter((fact) => Number.isFinite(numberOrNull(fact.val)))
    .sort(sortByEndThenFiledDesc)[0] || null;
}

function comparablePriorYtdFact(facts, latest) {
  if (!latest || !latest.fp || !Number.isFinite(Number(latest.fy))) return null;
  return facts
    .filter((fact) => fact.form === '10-Q')
    .filter((fact) => fact.fp === latest.fp)
    .filter((fact) => Number(fact.fy) === Number(latest.fy) - 1)
    .filter((fact) => Number.isFinite(numberOrNull(fact.val)))
    .sort(sortByEndThenFiledDesc)[0] || null;
}

function ttmFromCompanyFacts(companyFacts, tags) {
  for (const tag of tags) {
    const facts = unitFacts(companyFacts, tag);
    const annual = annualFact(facts);
    if (!annual) continue;

    const latestYtd = latestYtdQuarterFact(facts);
    const priorYtd = comparablePriorYtdFact(facts, latestYtd);
    const annualValue = numberOrNull(annual.val);

    if (latestYtd && priorYtd && String(latestYtd.end) > String(annual.end)) {
      return {
        value: annualValue + numberOrNull(latestYtd.val) - numberOrNull(priorYtd.val),
        tag,
        method: 'latest annual plus current YTD minus prior-year comparable YTD',
      };
    }

    return {
      value: annualValue,
      tag,
      method: 'latest annual fact',
    };
  }
  return null;
}

function instantFromCompanyFacts(companyFacts, tags) {
  for (const tag of tags) {
    const fact = unitFacts(companyFacts, tag)
      .filter((candidate) => ['10-Q', '10-K', '20-F', '40-F'].includes(candidate.form))
      .filter((candidate) => candidate.end && Number.isFinite(numberOrNull(candidate.val)))
      .sort(sortByEndThenFiledDesc)[0];
    if (fact) return { value: numberOrNull(fact.val), tag, method: 'latest instant fact' };
  }
  return null;
}

function totalDebtFromCompanyFacts(companyFacts) {
  const total = instantFromCompanyFacts(companyFacts, [
    'DebtAndFinanceLeaseObligations',
    'LongTermDebtAndFinanceLeaseObligations',
    'LongTermDebt',
  ]);
  if (total) return total;

  const components = [
    instantFromCompanyFacts(companyFacts, ['ShortTermBorrowings', 'DebtCurrent', 'LongTermDebtCurrent', 'LongTermDebtAndFinanceLeaseObligationsCurrent']),
    instantFromCompanyFacts(companyFacts, ['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent']),
  ].filter(Boolean);

  if (!components.length) return null;
  return {
    value: components.reduce((sumValue, component) => sumValue + component.value, 0),
    tag: components.map((component) => component.tag).join(' + '),
    method: 'sum of latest current and noncurrent debt facts',
  };
}

function extractSecCompanyFacts(companyFacts) {
  const revenue = ttmFromCompanyFacts(companyFacts, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ]);
  const netIncome = ttmFromCompanyFacts(companyFacts, ['NetIncomeLoss', 'ProfitLoss']);
  const operatingCashFlow = ttmFromCompanyFacts(companyFacts, [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ]);
  const capex = ttmFromCompanyFacts(companyFacts, [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'PaymentsToAcquireProductiveAssets',
  ]);
  const cash = instantFromCompanyFacts(companyFacts, [
    'CashAndCashEquivalentsAndShortTermInvestments',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
    'CashAndCashEquivalentsAtCarryingValue',
  ]);
  const debt = totalDebtFromCompanyFacts(companyFacts);

  const extracted = {
    quarter_count: { income: 0, balance: 0, cashflow: 0 },
    ttm_revenue: revenue && revenue.value,
    ttm_net_income: netIncome && netIncome.value,
    ttm_operating_cash_flow: operatingCashFlow && operatingCashFlow.value,
    ttm_capex: capex ? -Math.abs(capex.value) : null,
    ttm_free_cash_flow: operatingCashFlow && capex ? operatingCashFlow.value - Math.abs(capex.value) : null,
    cash_and_short_term_investments: cash && cash.value,
    total_debt: debt && debt.value,
    net_debt: debt && cash ? debt.value - cash.value : null,
    ttm_quality: {
      ttm_revenue: { valid: Boolean(revenue), method: revenue && revenue.method },
      ttm_net_income: { valid: Boolean(netIncome), method: netIncome && netIncome.method },
      ttm_operating_cash_flow: { valid: Boolean(operatingCashFlow), method: operatingCashFlow && operatingCashFlow.method },
      ttm_capex: { valid: Boolean(capex), method: capex && capex.method },
      ttm_free_cash_flow: { valid: Boolean(operatingCashFlow && capex), method: operatingCashFlow && capex ? 'operating cash flow minus capex' : null },
    },
    source: 'sec_companyfacts',
    sec_fact_tags: {
      revenue: revenue && revenue.tag,
      net_income: netIncome && netIncome.tag,
      operating_cash_flow: operatingCashFlow && operatingCashFlow.tag,
      capex: capex && capex.tag,
      cash: cash && cash.tag,
      debt: debt && debt.tag,
    },
  };

  if (!extracted.ttm_net_income && !extracted.ttm_free_cash_flow) return null;
  return extracted;
}

function mergeSecFactsIntoFinancials(providerFinancials, secFinancials) {
  const hasProviderFundamentals = Boolean(
    providerFinancials
      && Number.isFinite(providerFinancials.net_debt)
      && (
        (providerFinancials.ttm_quality
          && providerFinancials.ttm_quality.ttm_free_cash_flow
          && providerFinancials.ttm_quality.ttm_free_cash_flow.valid)
        || (providerFinancials.ttm_quality
          && providerFinancials.ttm_quality.ttm_net_income
          && providerFinancials.ttm_quality.ttm_net_income.valid)
      )
  );
  if (hasProviderFundamentals || !secFinancials) return providerFinancials;
  return {
    ...providerFinancials,
    ...secFinancials,
    quarter_count: providerFinancials.quarter_count,
  };
}

async function fetchSecurity(input, env, secTickerMap = null) {
  const fmpKey = env.FMP_API_KEY;
  const alphaKey = env.ALPHAVANTAGE_API_KEY || env.ALPHA_VANTAGE_API_KEY;
  const massiveKey = env.MASSIVE_API_KEY || env.POLYGON_API_KEY;
  if (!fmpKey || !alphaKey || !massiveKey) throw new Error('Missing FMP, Alpha Vantage, or Massive/Polygon API key.');

  const endpoints = {};
  for (const [key, endpoint, params] of [
    ['fmp_profile', 'profile', { symbol: input.fmpSymbol }],
    ['fmp_quote', 'quote', { symbol: input.fmpSymbol }],
    ['fmp_income', 'income-statement', { symbol: input.fmpSymbol, period: 'quarter', limit: 4 }],
    ['fmp_balance', 'balance-sheet-statement', { symbol: input.fmpSymbol, period: 'quarter', limit: 4 }],
    ['fmp_cashflow', 'cash-flow-statement', { symbol: input.fmpSymbol, period: 'quarter', limit: 4 }],
  ]) {
    const request = endpointUrl(`https://financialmodelingprep.com/stable/${endpoint}`, params, {
      key: 'apikey',
      value: fmpKey,
    });
    endpoints[key] = await fetchJson(key, request.url, request.redacted);
  }

  const alpha = endpointUrl('https://www.alphavantage.co/query', {
    function: 'GLOBAL_QUOTE',
    symbol: input.alphaSymbol,
  }, { key: 'apikey', value: alphaKey });
  endpoints.alpha_quote = await fetchJson('alpha_quote', alpha.url, alpha.redacted);

  if (input.massive) {
    const detailsPath = `/v3/reference/tickers/${encodeURIComponent(input.massiveSymbol)}`;
    const prevPath = `/v2/aggs/ticker/${encodeURIComponent(input.massiveSymbol)}/prev`;
    const details = endpointUrl(`https://api.polygon.io${detailsPath}`, {}, { key: 'apiKey', value: massiveKey });
    const prev = endpointUrl(`https://api.polygon.io${prevPath}`, { adjusted: true }, { key: 'apiKey', value: massiveKey });
    endpoints.massive_details = await fetchJson('massive_details', details.url, details.redacted);
    endpoints.massive_prev = await fetchJson('massive_prev', prev.url, prev.redacted);
  }

  const profile = firstObject(endpoints.fmp_profile.body);
  const quote = firstObject(endpoints.fmp_quote.body);
  const income = firstArray(endpoints.fmp_income.body);
  const balance = firstArray(endpoints.fmp_balance.body);
  const cashflow = firstArray(endpoints.fmp_cashflow.body);
  const alphaQuote = endpoints.alpha_quote.body && endpoints.alpha_quote.body['Global Quote'];
  const massive = endpoints.massive_details && endpoints.massive_details.body && endpoints.massive_details.body.results;
  const prev = endpoints.massive_prev
    && endpoints.massive_prev.body
    && endpoints.massive_prev.body.results
    && endpoints.massive_prev.body.results[0];

  const tickerMapCik = findCikForSecEligibleInput(input, secTickerMap && secTickerMap.body);
  if (tickerMapCik && !(massive && massive.cik) && secTickerMap) {
    endpoints.sec_company_tickers = {
      name: secTickerMap.name,
      ok: secTickerMap.ok,
      status: secTickerMap.status,
      url: secTickerMap.url,
      error: secTickerMap.error,
      body: null,
    };
  }

  const cik = (massive && massive.cik) || tickerMapCik;
  if (cik) {
    const secUrl = `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`;
    endpoints.sec_submissions = await fetchJson('sec_submissions', secUrl, secUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });
    const secFactsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;
    endpoints.sec_companyfacts = await fetchJson('sec_companyfacts', secFactsUrl, secFactsUrl, {
      headers: { 'User-Agent': SEC_USER_AGENT },
    });
  }
  const secBody = endpoints.sec_submissions && endpoints.sec_submissions.body;
  const latestBalance = balance[0] || {};
  const ttmRevenue = ttmMetricFromQuarterRows(income, 'revenue');
  const ttmNetIncome = ttmMetricFromQuarterRows(income, 'netIncome');
  const ttmOperatingCashFlow = ttmMetricFromQuarterRows(cashflow, 'operatingCashFlow');
  const ttmCapex = ttmMetricFromQuarterRows(cashflow, 'capitalExpenditure');
  const ttmFreeCashFlow = ttmMetricFromQuarterRows(cashflow, 'freeCashFlow');
  const price = numberOrNull(quote && (quote.price || quote.close))
    || numberOrNull(alphaQuote && alphaQuote['05. price'])
    || numberOrNull(prev && prev.c)
    || numberOrNull(profile && profile.price);
  const marketCap = numberOrNull(quote && quote.marketCap)
    || numberOrNull(profile && profile.marketCap)
    || numberOrNull(massive && massive.market_cap);
  const shares = numberOrNull(massive && massive.weighted_shares_outstanding)
    || (marketCap && price ? marketCap / price : null);
  const netDebt = netDebtFromBalance(latestBalance);
  const providerFinancials = {
    quarter_count: { income: income.length, balance: balance.length, cashflow: cashflow.length },
    latest_fiscal_date: income[0] && income[0].date,
    latest_filing_date: income[0] && income[0].filingDate,
    ttm_revenue: ttmRevenue.value,
    ttm_net_income: ttmNetIncome.value,
    ttm_operating_cash_flow: ttmOperatingCashFlow.value,
    ttm_capex: ttmCapex.value,
    ttm_free_cash_flow: ttmFreeCashFlow.value,
    cash_and_short_term_investments: numberOrNull(latestBalance.cashAndShortTermInvestments),
    total_debt: numberOrNull(latestBalance.totalDebt),
    net_debt: netDebt,
    ttm_quality: {
      ttm_revenue: ttmRevenue,
      ttm_net_income: ttmNetIncome,
      ttm_operating_cash_flow: ttmOperatingCashFlow,
      ttm_capex: ttmCapex,
      ttm_free_cash_flow: ttmFreeCashFlow,
    },
    source: income.length || balance.length || cashflow.length ? 'provider_statements' : null,
  };
  const secFinancials = extractSecCompanyFacts(endpoints.sec_companyfacts && endpoints.sec_companyfacts.body);
  const financials = mergeSecFactsIntoFinancials(providerFinancials, secFinancials);

  return {
    input,
    endpoints,
    symbol: input.ticker,
    listed: Boolean((massive && massive.active) || (profile && profile.isActivelyTrading) || price),
    identifiers: {
      exchange: (profile && profile.exchange) || input.exchange,
      exchange_full_name: (profile && profile.exchangeFullName) || input.exchange,
      mic: (massive && massive.primary_exchange) || input.mic,
      ticker: input.ticker,
      provider_symbol: input.fmpSymbol,
      cik: (massive && massive.cik) || (secBody && String(secBody.cik).padStart(10, '0')) || tickerMapCik || null,
      isin: (profile && profile.isin) || KNOWN_ISINS[input.ticker] || null,
      currency: (profile && profile.currency) || input.fallbackCurrency,
    },
    company: {
      name: (profile && profile.companyName) || (massive && massive.name) || (secBody && secBody.name) || input.ticker,
      legal_name_sec: secBody && secBody.name,
      description: profile && profile.description,
      sector: profile && profile.sector,
      industry: profile && profile.industry,
      ipo_date: (profile && profile.ipoDate) || (massive && massive.list_date) || null,
    },
    market: {
      price,
      price_sources: {
        fmp_quote: numberOrNull(quote && (quote.price || quote.close)),
        fmp_profile: numberOrNull(profile && profile.price),
        alpha_quote: numberOrNull(alphaQuote && alphaQuote['05. price']),
        massive_prev_close: numberOrNull(prev && prev.c),
      },
      previous_aggregate_date: prev && prev.t ? new Date(prev.t).toISOString().slice(0, 10) : null,
      market_cap: marketCap,
      shares_outstanding: shares,
      volume: numberOrNull(quote && quote.volume) || numberOrNull(alphaQuote && alphaQuote['06. volume']) || numberOrNull(prev && prev.v),
    },
    financials,
    sec: {
      tickers: secBody && secBody.tickers,
      exchanges: secBody && secBody.exchanges,
      recent_filings: compactFilings(secBody),
    },
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(value, currency, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const symbol = currency === 'EUR' ? 'EUR ' : '$';
  return `${symbol}${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function compactMoney(value, currency) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  const symbol = currency === 'EUR' ? 'EUR ' : '$';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000) return `${symbol}${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  return money(value, currency);
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(0)}%`;
}

function table(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function chooseMultiples(security, metricName) {
  const text = `${security.company.name} ${security.company.sector || ''} ${security.company.industry || ''}`.toLowerCase();
  if (/semiconductor/.test(text)) return metricName === 'ttm_free_cash_flow' ? [35, 45, 55, 65] : [28, 35, 45, 55];
  if (/electrical|power|energy|utilities|infrastructure/.test(text)) return metricName === 'ttm_free_cash_flow' ? [14, 18, 24, 30] : [18, 22, 26, 32];
  if (/industrial|machinery|manufacturing/.test(text)) return metricName === 'ttm_free_cash_flow' ? [12, 16, 20, 24] : [16, 20, 24, 28];
  if (/software|technology|finance|payments/.test(text)) return metricName === 'ttm_free_cash_flow' ? [16, 20, 26, 32] : [20, 26, 32, 38];
  return metricName === 'ttm_free_cash_flow' ? [10, 14, 18, 22] : [14, 18, 22, 26];
}

function valuePerShare(metric, multiple, netDebt, shares) {
  return ((metric * multiple) - netDebt) / shares;
}

function blendedValuePerShare(primaryMetric, primaryMultiple, secondaryMetric, secondaryMultiple, netDebt, shares) {
  if (!Number.isFinite(secondaryMetric) || !Number.isFinite(secondaryMultiple)) {
    return valuePerShare(primaryMetric, primaryMultiple, netDebt, shares);
  }

  return (
    valuePerShare(primaryMetric, primaryMultiple, netDebt, shares) * 0.7
    + valuePerShare(secondaryMetric, secondaryMultiple, netDebt, shares) * 0.3
  );
}

function hasValidTtmMetric(financials, metricName) {
  const metric = numberOrNull(financials && financials[metricName]);
  const quality = financials && financials.ttm_quality && financials.ttm_quality[metricName];
  return Number.isFinite(metric) && metric > 0 && Boolean(quality && quality.valid);
}

function buildAnalysis(security) {
  const price = security.market.price;
  const shares = security.market.shares_outstanding;
  const netDebt = security.financials.net_debt;
  const hasFcf = hasValidTtmMetric(security.financials, 'ttm_free_cash_flow');
  const hasNetIncome = hasValidTtmMetric(security.financials, 'ttm_net_income');
  const metricName = hasFcf ? 'ttm_free_cash_flow' : hasNetIncome ? 'ttm_net_income' : null;
  if (!price || !shares || !Number.isFinite(netDebt) || !metricName) {
    return {
      mode: 'monitor',
      stance: 'No Model Stance',
      confidence: 'Low',
      readinessLabel: 'Monitor-only research draft',
    };
  }

  const metric = security.financials[metricName];
  const [bearMultiple, baseLowMultiple, baseHighMultiple, bullMultiple] = chooseMultiples(security, metricName);
  const useEarningsCrossCheck = metricName === 'ttm_free_cash_flow' && hasNetIncome;
  const earningsMetric = useEarningsCrossCheck ? security.financials.ttm_net_income : null;
  const [, baseLowEarningsMultiple, baseHighEarningsMultiple] = useEarningsCrossCheck
    ? chooseMultiples(security, 'ttm_net_income')
    : [null, null, null];
  const bear = valuePerShare(metric, bearMultiple, netDebt, shares);
  const baseLow = blendedValuePerShare(metric, baseLowMultiple, earningsMetric, baseLowEarningsMultiple, netDebt, shares);
  const baseHigh = blendedValuePerShare(metric, baseHighMultiple, earningsMetric, baseHighEarningsMultiple, netDebt, shares);
  const bull = valuePerShare(metric, bullMultiple, netDebt, shares);
  const lowUpside = ((baseLow / price) - 1) * 100;
  const highUpside = ((baseHigh / price) - 1) * 100;
  let stance = 'Hold';
  if (lowUpside >= 15) stance = 'Buy';
  else if (highUpside <= -15) stance = 'Sell / Trim';
  else if (highUpside >= 15) stance = 'Hold / Accumulate on Pullbacks';

  return {
    mode: 'valued',
    metricName,
    metricLabel: metricName === 'ttm_free_cash_flow' ? 'TTM FCF' : 'TTM net income',
    stance,
    bear,
    baseLow,
    baseHigh,
    bull,
    lowUpside,
    highUpside,
    confidence: 'Low',
    readinessLabel: 'Internal research draft',
    valuationMethod: useEarningsCrossCheck
      ? '70% TTM FCF bridge and 30% earnings-power cross-check'
      : `${metricName === 'ttm_free_cash_flow' ? 'TTM FCF' : 'TTM net income'} multiple bridge adjusted for net debt`,
    multiples: {
      bearMultiple,
      baseLowMultiple,
      baseHighMultiple,
      bullMultiple,
      baseLowEarningsMultiple,
      baseHighEarningsMultiple,
    },
    valuationInputs: {
      metric_name: metricName,
      metric_label: metricName === 'ttm_free_cash_flow' ? 'TTM FCF' : 'TTM net income',
      metric_value: metric,
      earnings_cross_check_value: earningsMetric,
      blend_weights: useEarningsCrossCheck ? { primary_metric: 0.7, earnings_cross_check: 0.3 } : null,
      shares_outstanding: shares,
      net_debt: netDebt,
      current_price: price,
      multiples: {
        bearMultiple,
        baseLowMultiple,
        baseHighMultiple,
        bullMultiple,
        baseLowEarningsMultiple,
        baseHighEarningsMultiple,
      },
    },
    valuationScenarios: {
      bear: { multiple: bearMultiple, fair_value_per_share: bear, upside_pct: ((bear / price) - 1) * 100 },
      base_low: { multiple: baseLowMultiple, earnings_multiple: baseLowEarningsMultiple, fair_value_per_share: baseLow, upside_pct: lowUpside },
      base_high: { multiple: baseHighMultiple, earnings_multiple: baseHighEarningsMultiple, fair_value_per_share: baseHigh, upside_pct: highUpside },
      bull: { multiple: bullMultiple, fair_value_per_share: bull, upside_pct: ((bull / price) - 1) * 100 },
    },
  };
}

function endpointSummary(security) {
  return Object.entries(security.endpoints).map(([key, endpoint]) => ({
    source_id: `${key.toUpperCase()}_${security.symbol}_${REPORT_RUN_ID.replaceAll('-', '_')}`,
    source_type: key.startsWith('sec') ? 'filing' : 'market_data',
    publisher: key.startsWith('sec') ? 'U.S. Securities and Exchange Commission' : key.startsWith('alpha') ? 'Alpha Vantage' : key.startsWith('massive') ? 'Massive / Polygon' : 'Financial Modeling Prep',
    title: `${key.replaceAll('_', ' ')} - ${security.symbol}`,
    url: endpoint.url,
    accessed_at: ACCESSED_AT,
    status: endpoint.status,
    license_note: 'Stored URL contains no API key.',
  }));
}

function reportMarkdown(security, analysis) {
  const currency = security.identifiers.currency || 'USD';
  const title = `${security.company.name} Analyst Report`;
  const financialSource = security.financials.source === 'sec_companyfacts'
    ? 'SEC Company Facts standard XBRL data'
    : 'provider statement data';
  if (analysis.mode === 'monitor') {
    return `# ${title}

Generated: ${ACCESSED_AT.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}
Security ID: \`${security.input.id}\`
Validated equity coverage member. Educational purpose only. This is a monitor-only research draft, not investment advice, not a personalized recommendation, and not a suitability assessment.

## Verdict

${table([
      ['Item', 'View'],
      ['---', '---:'],
      ['No Model Stance', 'Monitor only'],
      ['Horizon', 'Monitor until source-backed fundamentals are available'],
      ['Current price', money(security.market.price, currency, 2)],
      ['Base fair-value range', 'Withheld'],
      ['Confidence', analysis.confidence],
    ])}

${security.company.name} / ${security.symbol} is provider-validated as a listed security, but the current provider coverage does not expose the statement data needed for a source-backed valuation.

## Decision Drivers

- Provider data validates the instrument identifiers and latest observable quote data.
- FMP quote, income statement, balance sheet, and cash-flow endpoints were unavailable or restricted for valuation use in this run.
- A Buy/Hold/Sell valuation call would be unsupported until revenue, profitability, balance-sheet, and cash-flow data are reconciled.

## Broker Readiness

Readiness label: **Monitor-only research draft**.

This report should not be used as a valuation-backed recommendation. The minimum next step is filing extraction or a provider endpoint with statement coverage.

${table([
      ['Gate', 'Status', 'Gap'],
      ['---', '---', '---'],
      ['Source reconciliation', 'Partial', 'Instrument and quote data are validated; fundamentals are not complete.'],
      ['DCF', 'Blocked', 'No source-backed cash-flow baseline.'],
      ['Relative valuation', 'Blocked', 'Needs normalized profitability and a peer set.'],
      ['WACC x terminal-growth sensitivity', 'Blocked', 'Cannot run until a cash-flow model exists.'],
      ['Peer and consensus context', 'Missing', 'Needs consensus expectations and estimate revision direction.'],
    ])}

## Triangulation Plan

${table([
      ['Method', 'Required work', 'Output'],
      ['---', '---', '---'],
      ['Filing extraction', 'Extract revenue, profitability, balance-sheet, and cash-flow data from filings.', 'Auditable operating baseline.'],
      ['Relative valuation', 'Build peer set and compare normalized valuation multiples.', 'Peer-implied value range.'],
      ['Variant view', 'State what growth, margin, and multiple assumptions the current quote embeds.', 'Bull/base/bear decision tree.'],
    ])}

## Key Risks

- Recent or thin provider coverage can be incomplete or corrected after data vendors normalize their feeds.
- Single-provider identifiers and market cap require reconciliation before investor-grade use.
- Without fundamentals, the report can monitor price and filings but cannot estimate intrinsic value.

## Compact Audit

${table([
      ['Area', 'Status'],
      ['---', '---'],
      ['Instrument', `${security.identifiers.ticker} / ${security.identifiers.mic} / ${security.identifiers.isin || 'ISIN unavailable'}.`],
      ['Price', `${money(security.market.price, currency, 2)} from best available provider quote/previous close.`],
      ['Market cap', compactMoney(security.market.market_cap, currency)],
      ['Filing metadata', security.sec.recent_filings.length ? security.sec.recent_filings.slice(0, 3).map((filing) => `${filing.form} ${filing.filing_date}`).join(', ') : 'No SEC metadata loaded for this exchange.'],
      ['Fundamentals', 'Statement endpoints unavailable/restricted or insufficient; no TTM valuation model built.'],
    ])}

Source packet: \`${sourcePacketPath(security.input)}\`
`;
  }

  return `# ${title}

Generated: ${ACCESSED_AT.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}
Security ID: \`${security.input.id}\`
Validated equity coverage member. Educational purpose only. Model-implied stance only. This is not investment advice, not a personalized recommendation, and not a suitability assessment.

## Verdict

${table([
    ['Item', 'View'],
    ['---', '---:'],
    ['Model-implied stance', analysis.stance],
    ['Horizon', '12-18 months'],
    ['Current price', money(security.market.price, currency, 2)],
    ['Base fair-value range', `${money(analysis.baseLow, currency)}-${money(analysis.baseHigh, currency)}`],
    ['Base upside/downside', `${pct(analysis.lowUpside)} to ${pct(analysis.highUpside)}`],
    ['Confidence', analysis.confidence],
  ])}

${security.company.name} has source-backed statement data in this run from ${financialSource}, so the report uses a compact ${analysis.metricLabel} multiple bridge. This is a screening model, not a broker-grade valuation.

## Decision Drivers

- ${analysis.metricLabel} of ${compactMoney(security.financials[analysis.metricName], currency)} supports a valuation bridge against the current quote; the financial source is ${financialSource}.
- The model uses ${analysis.multiples.baseLowMultiple}x to ${analysis.multiples.baseHighMultiple}x ${analysis.metricLabel}; the bear and bull cases show sensitivity to multiple compression or expansion.
- The company is relevant to AI infrastructure, power, electrification, industrial capacity, or data-center supply-chain demand, but that theme still needs peer and consensus validation.

## Valuation Bridge

Primary model: ${analysis.valuationMethod}.
Formula: \`(${analysis.metricLabel} * multiple - net debt) / shares outstanding\`${analysis.valuationInputs.blend_weights ? ', with base cases blended 70% primary metric and 30% earnings cross-check.' : '.'}

${table([
    ['Scenario', 'Assumption', 'Fair value', 'Versus current'],
    ['---', '---', '---:', '---:'],
    ['Bear', `${analysis.multiples.bearMultiple}x ${analysis.metricLabel}`, money(analysis.bear, currency), pct(((analysis.bear / security.market.price) - 1) * 100)],
    ['Base low', analysis.multiples.baseLowEarningsMultiple ? `${analysis.multiples.baseLowMultiple}x ${analysis.metricLabel} blended with ${analysis.multiples.baseLowEarningsMultiple}x TTM net income` : `${analysis.multiples.baseLowMultiple}x ${analysis.metricLabel}`, money(analysis.baseLow, currency), pct(analysis.lowUpside)],
    ['Base high', analysis.multiples.baseHighEarningsMultiple ? `${analysis.multiples.baseHighMultiple}x ${analysis.metricLabel} blended with ${analysis.multiples.baseHighEarningsMultiple}x TTM net income` : `${analysis.multiples.baseHighMultiple}x ${analysis.metricLabel}`, money(analysis.baseHigh, currency), pct(analysis.highUpside)],
    ['Bull', `${analysis.multiples.bullMultiple}x ${analysis.metricLabel}`, money(analysis.bull, currency), pct(((analysis.bull / security.market.price) - 1) * 100)],
  ])}

## Broker Readiness

Readiness label: **${analysis.readinessLabel}**.

This report is useful for screening, but it is not CEO-ready or institutional-investor-ready. It is missing full DCF, peer multiple triangulation, consensus estimates, and WACC x terminal-growth sensitivity.

${table([
    ['Gate', 'Status', 'Gap'],
    ['---', '---', '---'],
    ['Source reconciliation', 'Partial', security.financials.source === 'sec_companyfacts' ? 'SEC Company Facts standard tags were used, but filing context and line-item reconciliation remain partial.' : 'Provider statement data was used, but filing line items were not reconciled.'],
    ['DCF', 'Missing', 'Needs explicit revenue, margin, tax, reinvestment, WACC, and terminal assumptions.'],
    ['Relative valuation', 'Missing', 'Needs justified peer set and target premium or discount.'],
    ['SOTP-if-applicable', 'Missing', 'Needs segment-level support or explicit non-applicability.'],
    ['WACC x terminal-growth sensitivity', 'Missing', 'Required before investor-ready labeling.'],
    ['Peer and consensus context', 'Missing', 'Needs consensus revenue/EPS/FCF expectations and estimate revision direction.'],
  ])}

## Triangulation Plan

${table([
    ['Method', 'Required work', 'Output'],
    ['---', '---', '---'],
    ['DCF', 'Build a 5-year FCFF forecast from filings and consensus assumptions.', 'Per-share value plus WACC x terminal-growth sensitivity.'],
    ['Relative valuation', 'Compare against a justified peer set.', 'Peer-implied range and premium/discount rationale.'],
    ['Variant view', 'State what growth, margin, capex, and multiple assumptions the current quote embeds.', 'Bull/base/bear decision tree.'],
  ])}

## Key Risks

- Multiple compression can dominate fundamentals if AI infrastructure expectations cool.
- Capex cycles and demand timing can make trailing cash flow a poor normalized base.
- Provider data must be reconciled to filings before broker-grade use.

## Compact Audit

${table([
    ['Area', 'Status'],
    ['---', '---'],
    ['Instrument', `${security.identifiers.ticker} / ${security.identifiers.mic} / ${security.identifiers.isin || 'ISIN unavailable'}.`],
    ['Price', `${money(security.market.price, currency, 2)} from best available provider quote/previous close.`],
    [analysis.metricLabel, `${compactMoney(security.financials[analysis.metricName], currency)} from ${financialSource}.`],
    ['Net debt', compactMoney(security.financials.net_debt, currency)],
    ['Filing metadata', security.sec.recent_filings.length ? security.sec.recent_filings.slice(0, 3).map((filing) => `${filing.form} ${filing.filing_date}`).join(', ') : 'No SEC metadata loaded for this exchange.'],
  ])}

Source packet: \`${sourcePacketPath(security.input)}\`
`;
}

function markdownToHtml(markdown, security, analysis) {
  const sections = markdown.split(/\n## /);
  const header = sections.shift();
  const intro = header
    .split('\n')
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('Generated:') && !line.startsWith('Security ID:'))
    .join(' ')
    .replaceAll('`', '');
  const inline = (value) => escapeHtml(value).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  const tableToHtml = (block) => {
    const rows = block.trim().split('\n').filter((line) => line.startsWith('|'));
    const data = rows.filter((_, index) => index !== 1).map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()));
    const [head, ...body] = data;
    return `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  };
  const blockToHtml = (block) => {
    const out = [];
    let paragraph = [];
    let bullets = [];
    let tableLines = [];
    const flush = () => {
      if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      if (bullets.length) out.push(`<ul>${bullets.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
      if (tableLines.length) out.push(tableToHtml(tableLines.join('\n')));
      paragraph = [];
      bullets = [];
      tableLines = [];
    };
    for (const line of block.trim().split('\n')) {
      if (!line.trim()) { flush(); continue; }
      if (line.startsWith('|')) { if (paragraph.length || bullets.length) flush(); tableLines.push(line); continue; }
      if (line.startsWith('- ')) { if (paragraph.length || tableLines.length) flush(); bullets.push(line.slice(2)); continue; }
      if (bullets.length || tableLines.length) flush();
      paragraph.push(line);
    }
    flush();
    return out.join('\n');
  };
  const sectionHtml = sections.map((section) => {
    const [heading, ...body] = section.split('\n');
    return `<section class="card"><h2>${escapeHtml(heading.trim())}</h2>${blockToHtml(body.join('\n'))}</section>`;
  }).join('\n');
  const modelView = analysis.mode === 'monitor' ? 'MONITOR ONLY' : analysis.stance.toUpperCase();
  const readiness = analysis.mode === 'monitor' ? 'Monitor-only draft' : analysis.readinessLabel;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(security.company.name)} Analyst Report</title>
    <style>
      :root{--ink:#17201a;--muted:#677269;--panel:rgba(255,251,241,.9);--line:#d8cab2;--green:#0e6b5e;--blue:#244c73;--shadow:0 24px 70px rgba(23,32,26,.14);--display:"Iowan Old Style","Palatino","Book Antiqua",Georgia,serif;--sans:"Avenir Next","Gill Sans","Trebuchet MS",sans-serif;--mono:"SFMono-Regular","Cascadia Mono","Liberation Mono",monospace}
      *{box-sizing:border-box}body{margin:0;color:var(--ink);font-family:var(--sans);background:radial-gradient(circle at 10% 0%,rgba(14,107,94,.18),transparent 34rem),radial-gradient(circle at 94% 10%,rgba(36,76,115,.16),transparent 28rem),linear-gradient(135deg,#f8f0df 0%,#e5d4b8 100%)}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:linear-gradient(rgba(23,32,26,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(23,32,26,.045) 1px,transparent 1px);background-size:42px 42px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.72),transparent)}
      .shell{position:relative;width:min(1120px,calc(100% - 32px));margin:0 auto;padding:44px 0 72px}.report-nav{display:flex;margin-bottom:18px}.back-link{display:inline-flex;align-items:center;min-height:42px;padding:0 16px;border:1px solid rgba(14,107,94,.26);border-radius:999px;background:rgba(255,251,241,.62);color:var(--green);font-family:var(--mono);font-size:.78rem;font-weight:900;letter-spacing:.08em;text-decoration:none;text-transform:uppercase}
      .hero{display:grid;grid-template-columns:1fr minmax(280px,360px);gap:24px;margin-bottom:24px}.hero-main,.card,.verdict-card{border:1px solid rgba(216,202,178,.92);border-radius:32px;background:var(--panel);box-shadow:var(--shadow);backdrop-filter:blur(16px)}.hero-main{padding:42px}.verdict-card{padding:28px}.card{margin-top:22px;padding:26px;overflow-x:auto}.eyebrow{margin:0 0 10px;color:var(--green);font-family:var(--mono);font-size:.72rem;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
      h1,h2{margin:0;font-family:var(--display);letter-spacing:-.045em}h1{max-width:820px;font-size:clamp(3rem,7vw,6.5rem);line-height:.9}h2{margin-bottom:18px;font-size:clamp(1.8rem,3vw,2.8rem)}p,li{color:var(--muted);font-size:1rem;line-height:1.65}.lede{max-width:710px;margin:22px 0 0;font-size:1.1rem}.stance{display:inline-grid;place-items:center;min-height:52px;margin:8px 0 18px;padding:0 18px;border-radius:999px;background:rgba(36,76,115,.13);border:1px solid rgba(36,76,115,.34);color:var(--blue);font-family:var(--mono);font-size:.92rem;font-weight:900;letter-spacing:.08em;text-transform:uppercase}
      .metric{display:grid;gap:4px;padding:14px;border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.52)}.metric+.metric{margin-top:10px}.metric span{color:var(--muted);font-family:var(--mono);font-size:.72rem;text-transform:uppercase}.metric strong{font-size:1.16rem}table{width:100%;border-collapse:collapse;margin-top:14px;border-radius:18px;background:rgba(255,255,255,.44)}th,td{padding:13px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--green);font-family:var(--mono);font-size:.74rem;letter-spacing:.08em;text-transform:uppercase}td{color:var(--muted);line-height:1.45}code{padding:.12rem .3rem;border-radius:.4rem;background:rgba(14,107,94,.1);color:var(--green);font-family:var(--mono)}
      @media(max-width:820px){.shell{width:min(100% - 22px,1120px);padding-top:24px}.hero{grid-template-columns:1fr;gap:14px;margin-bottom:16px}.hero-main,.verdict-card,.card{border-radius:24px;padding:18px}.hero-main{padding:20px}h1{font-size:clamp(2.3rem,13vw,4.2rem);line-height:.92}.lede{margin-top:12px;font-size:.96rem}.stance{min-height:40px;margin:6px 0 10px}.metric{padding:10px 12px}}
    </style>
  </head>
  <body>
    <main class="shell">
      <nav class="report-nav" aria-label="Report navigation">
        <a class="back-link" href="/stock/${security.input.id}" aria-label="Back to ${escapeHtml(security.company.name)} stock detail">Back to stock</a>
      </nav>
      <section class="hero">
        <div class="hero-main">
          <p class="eyebrow">Validated Coverage / ${security.input.id} / ${ACCESSED_AT.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}</p>
          <h1>${escapeHtml(security.company.name)} Analyst Report</h1>
          <p class="lede">${inline(intro)}</p>
        </div>
        <aside class="verdict-card" aria-label="Report verdict">
          <p class="eyebrow">Model View</p>
          <div class="stance">${escapeHtml(modelView)}</div>
          <div class="metric"><span>Horizon</span><strong>${analysis.mode === 'monitor' ? 'Monitor' : '12-18 months'}</strong></div>
          <div class="metric"><span>Readiness</span><strong>${readiness}</strong></div>
          <div class="metric"><span>Source Packet</span><strong>${path.basename(sourcePacketPath(security.input))}</strong></div>
        </aside>
      </section>
      ${sectionHtml}
    </main>
  </body>
</html>
`;
}

function generateReport(security) {
  const analysis = buildAnalysis(security);
  const markdown = reportMarkdown(security, analysis);
  return {
    analysis,
    markdown,
    html: markdownToHtml(markdown, security, analysis),
  };
}

function buildSourcePacket(security, report) {
  const metrics = [
    { metric_id: 'current_price', normalized_value: security.market.price, unit: 'currency', currency: security.identifiers.currency },
    { metric_id: 'market_cap', normalized_value: security.market.market_cap, unit: 'currency', currency: security.identifiers.currency },
  ];
  if (report.analysis.mode === 'valued') {
    metrics.push({
      metric_id: 'financial_statement_source',
      normalized_value: security.financials.source || 'unknown',
      unit: 'source_label',
      currency: null,
    });
    metrics.push({
      metric_id: 'base_fair_value_range',
      normalized_value: [report.analysis.baseLow, report.analysis.baseHigh],
      unit: 'currency_per_share',
      currency: security.identifiers.currency,
      formula: `(${report.analysis.metricLabel} * multiple - net debt) / shares outstanding`,
    });
    metrics.push({
      metric_id: 'valuation_metric',
      normalized_value: security.financials[report.analysis.metricName],
      unit: 'currency',
      currency: security.identifiers.currency,
      formula: report.analysis.metricLabel,
    });
    metrics.push({
      metric_id: 'net_debt',
      normalized_value: security.financials.net_debt,
      unit: 'currency',
      currency: security.identifiers.currency,
    });
    metrics.push({
      metric_id: 'shares_outstanding',
      normalized_value: security.market.shares_outstanding,
      unit: 'shares',
      currency: null,
    });
  }
  return {
    generated_at: ACCESSED_AT,
    intended_use: 'research_aid_only',
    jurisdiction_note: 'Educational purpose only; not investment advice, not a personalized recommendation, and not a suitability assessment.',
    base_currency: security.identifiers.currency,
    run_scope: report.analysis.mode === 'monitor' ? 'single_security_monitor_report' : 'single_security_screening_report',
    securities: [{
      security_id: security.input.id,
      legal_name: security.company.name,
      instrument_status: 'listed',
      instrument_validation_status: report.analysis.mode === 'monitor' ? 'provider_verified_monitor_only' : 'provider_verified_internal_draft_report',
      identifiers: {
        exchange: security.identifiers.exchange_full_name,
        exchange_mic: security.identifiers.mic,
        local_ticker: security.identifiers.ticker,
        vendor_ticker: security.identifiers.provider_symbol,
        isin: security.identifiers.isin,
        currency: security.identifiers.currency,
        cik: security.identifiers.cik,
      },
      sources: endpointSummary(security),
      metrics,
      analysis_model: {
        stance: report.analysis.stance,
        horizon: report.analysis.mode === 'monitor' ? 'Monitor until source-backed fundamentals are available' : '12-18 months',
        confidence: report.analysis.confidence,
        readiness_label: report.analysis.readinessLabel,
        valuation_method: report.analysis.mode === 'monitor' ? null : report.analysis.valuationMethod,
        base_fair_value_low: report.analysis.mode === 'monitor' ? null : report.analysis.baseLow,
        base_fair_value_high: report.analysis.mode === 'monitor' ? null : report.analysis.baseHigh,
        base_upside_low_pct: report.analysis.mode === 'monitor' ? null : report.analysis.lowUpside,
        base_upside_high_pct: report.analysis.mode === 'monitor' ? null : report.analysis.highUpside,
        valuation_inputs: report.analysis.mode === 'monitor' ? null : report.analysis.valuationInputs,
        valuation_scenarios: report.analysis.mode === 'monitor' ? null : report.analysis.valuationScenarios,
      },
      broker_grade_gates: {
        source_reconciliation: 'partial',
        dcf: report.analysis.mode === 'monitor' ? 'blocked' : 'missing',
        relative_valuation: 'missing',
        sotp_if_applicable: 'missing',
        wacc_terminal_growth_sensitivity: report.analysis.mode === 'monitor' ? 'blocked' : 'missing',
        peer_consensus_context: 'missing',
        variant_view: report.analysis.mode === 'monitor' ? 'blocked' : 'partial',
      },
    }],
  };
}

function saveSourcePacket(security, report) {
  const packet = buildSourcePacket(security, report);
  const relativePath = sourcePacketPath(security.input);
  writeJson(relativePath, packet);
  return relativePath;
}

function writeJson(relativePath, data) {
  const absolutePath = path.join(PROJECT_DIR, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(data, null, 2)}\n`);
}

function writeText(relativePath, content) {
  const absolutePath = path.join(PROJECT_DIR, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content.endsWith('\n') ? content : `${content}\n`);
}

function updateWatchlist(entries) {
  const watchlistPath = path.join(PROJECT_DIR, 'config', 'watchlist.json');
  const watchlist = JSON.parse(fs.readFileSync(watchlistPath, 'utf8'));
  const byId = new Map(watchlist.securities.map((security) => [security.id, security]));
  for (const { security, report } of entries) {
    byId.set(security.input.id, {
      id: security.input.id,
      name: security.company.name,
      enabled: true,
      report_profile: report.analysis.mode === 'monitor' ? 'monitor_report' : 'general_equity',
      identifiers: {
        isin: security.identifiers.isin,
        mic: security.identifiers.mic,
        euronext_product_id: null,
        local_ticker: security.identifiers.ticker,
        currency: security.identifiers.currency,
      },
      provider_symbols: {
        fmp: security.identifiers.provider_symbol,
        alpha_vantage: security.input.alphaSymbol,
        massive: security.input.massive ? security.input.massiveSymbol : null,
      },
      validation_status: report.analysis.mode === 'monitor' ? 'provider_verified_monitor_only' : 'provider_verified_internal_draft_report',
      last_probe_at: ACCESSED_AT,
      last_report_path: reportPath(security.input, 'html'),
    });
  }
  watchlist.securities = Array.from(byId.values());
  writeJson('config/watchlist.json', watchlist);
}

async function main() {
  const inputs = process.argv.slice(2).map(parseSymbolInput);
  if (!inputs.length) throw new Error('Usage: npm run add-stocks -- NYSE:KLAR NASDAQ:CEG XETRA:SIE');
  const env = loadProjectEnv(PROJECT_DIR);
  const secTickerMap = inputs.some((input) => input.massive) ? await fetchSecTickerMap() : null;
  const entries = [];
  for (const input of inputs) {
    const security = await fetchSecurity(input, env, secTickerMap);
    const report = generateReport(security);
    writeText(reportPath(input, 'md'), report.markdown);
    writeText(reportPath(input, 'html'), report.html);
    const sourcePacket = saveSourcePacket(security, report);
    entries.push({ security, report, sourcePacket });
  }
  updateWatchlist(entries);
  console.log(JSON.stringify(entries.map(({ security, report, sourcePacket }) => ({
    id: security.input.id,
    name: security.company.name,
    isin: security.identifiers.isin,
    mic: security.identifiers.mic,
    report: reportPath(security.input, 'html'),
    source_packet: sourcePacket,
    stance: report.analysis.stance,
  })), null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = {
  parseSymbolInput,
  reportFileBase,
  buildSourcePacket,
  extractSecCompanyFacts,
  findCikForSecEligibleInput,
  findCikFromSecTickerMap,
  mergeSecFactsIntoFinancials,
  netDebtFromBalance,
  ttmMetricFromQuarterRows,
  generateReport,
  saveSourcePacket,
  updateWatchlist,
};
