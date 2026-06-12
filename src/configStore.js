const fs = require('node:fs');
const path = require('node:path');

function createEmptyWatchlist() {
  return { version: 1, securities: [] };
}

function watchlistPath(projectDir) {
  return path.join(projectDir, 'config', 'watchlist.json');
}

function ensureConfigDir(projectDir) {
  fs.mkdirSync(path.join(projectDir, 'config'), { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function loadWatchlist(projectDir = process.cwd()) {
  const parsed = readJson(watchlistPath(projectDir), createEmptyWatchlist());
  return {
    version: parsed.version || 1,
    securities: Array.isArray(parsed.securities) ? parsed.securities : [],
  };
}

function saveWatchlist(projectDir, watchlist) {
  ensureConfigDir(projectDir);
  writeJsonAtomic(watchlistPath(projectDir), watchlist);
  return watchlist;
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function normalizeUpper(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function makeSecurityId(input) {
  const identifiers = input.identifiers || {};
  const ticker = normalizeUpper(identifiers.local_ticker);
  const mic = normalizeUpper(identifiers.mic);
  const isin = normalizeUpper(identifiers.isin);
  const firstPart = ticker || isin;

  if (!firstPart) {
    throw new Error('Security requires an ISIN or local ticker.');
  }

  return [firstPart, mic].filter(Boolean).join('_').replace(/[^A-Z0-9_]/g, '_');
}

function normalizeSecurity(input) {
  const identifiers = input.identifiers || {};
  const isin = normalizeUpper(identifiers.isin);

  if (!isin) {
    throw new Error('Security requires an ISIN.');
  }

  const mic = normalizeUpper(identifiers.mic);
  const localTicker = normalizeUpper(identifiers.local_ticker);
  const currency = normalizeUpper(identifiers.currency);
  const euronextProductId = normalizeUpper(identifiers.euronext_product_id)
    || (mic ? `${isin}-${mic}` : null);

  return {
    id: normalizeUpper(input.id) || makeSecurityId(input),
    name: normalizeText(input.name) || isin,
    enabled: input.enabled !== false,
    report_profile: normalizeText(input.report_profile) || 'general_equity',
    identifiers: {
      isin,
      mic,
      euronext_product_id: euronextProductId,
      local_ticker: localTicker,
      currency,
    },
    provider_symbols: {
      fmp: normalizeText(input.provider_symbols && input.provider_symbols.fmp),
      alpha_vantage: normalizeText(input.provider_symbols && input.provider_symbols.alpha_vantage),
      massive: normalizeText(input.provider_symbols && input.provider_symbols.massive),
    },
    validation_status: normalizeText(input.validation_status) || 'pending_validation',
    last_probe_at: normalizeText(input.last_probe_at),
    last_report_path: normalizeText(input.last_report_path),
  };
}

function addSecurity(projectDir, input) {
  const watchlist = loadWatchlist(projectDir);
  const security = normalizeSecurity(input);

  if (watchlist.securities.some((item) => item.id === security.id)) {
    throw new Error(`Security already exists: ${security.id}`);
  }

  watchlist.securities.push(security);
  saveWatchlist(projectDir, watchlist);
  return security;
}

function removeSecurity(projectDir, id) {
  const watchlist = loadWatchlist(projectDir);
  const normalizedId = normalizeUpper(id);
  const index = watchlist.securities.findIndex((item) => item.id === normalizedId);

  if (index === -1) {
    throw new Error(`Security not found: ${id}`);
  }

  const [removed] = watchlist.securities.splice(index, 1);
  saveWatchlist(projectDir, watchlist);
  return removed;
}

function getSecurity(projectDir, id) {
  const normalizedId = normalizeUpper(id);
  return loadWatchlist(projectDir).securities.find((item) => item.id === normalizedId) || null;
}

function getProviderStatus(env = process.env) {
  return {
    fmp: Boolean(normalizeText(env.FMP_API_KEY)),
    alpha_vantage: Boolean(normalizeText(env.ALPHAVANTAGE_API_KEY || env.ALPHA_VANTAGE_API_KEY)),
    massive: Boolean(normalizeText(env.MASSIVE_API_KEY || env.POLYGON_API_KEY)),
  };
}

module.exports = {
  createEmptyWatchlist,
  loadWatchlist,
  saveWatchlist,
  addSecurity,
  removeSecurity,
  getSecurity,
  getProviderStatus,
  normalizeSecurity,
};
