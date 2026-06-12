function qs(selector) {
  return document.querySelector(selector);
}

function text(value, fallback = 'N/A') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function reportHref(path) {
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

function currentSecurityId() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return decodeURIComponent(parts[1] || '');
}

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text(value);

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function money(value, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return text(value);

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: number >= 100 ? 0 : 2,
    }).format(number);
  } catch {
    return `${number.toFixed(2)} ${currency}`;
  }
}

function rangeValue(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const low = Number(value[0]);
  const high = Number(value[1]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return [Math.min(low, high), Math.max(low, high)];
}

function renderDefinitionList(node, entries) {
  node.innerHTML = entries.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `).join('');
}

function recommendationPill(recommendation) {
  const label = recommendation && recommendation.label ? recommendation.label : 'Not run';
  const tone = recommendation && recommendation.tone ? recommendation.tone : 'missing';
  return `<span class="pill recommendation ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function latestReport(reports) {
  return Array.isArray(reports) && reports.length ? reports[0] : null;
}

function renderLatestSummary(security, latest) {
  const recommendation = latest ? latest.recommendation : security.recommendation;
  const generatedAt = latest ? formatDate(latest.generated_at) : 'No report history yet';
  const horizon = latest && latest.horizon ? latest.horizon : 'N/A';
  const confidence = latest && latest.confidence ? latest.confidence : 'N/A';
  const readiness = latest && latest.readiness_label ? latest.readiness_label : text(security.validation_status);

  qs('#validation-status').innerHTML = recommendationPill(recommendation);
  qs('#latest-summary').innerHTML = `
    <div class="summary-item">
      <span>Horizon</span>
      <strong>${escapeHtml(horizon)}</strong>
    </div>
    <div class="summary-item">
      <span>Confidence</span>
      <strong>${escapeHtml(confidence)}</strong>
    </div>
    <div class="summary-item">
      <span>Status</span>
      <strong>${escapeHtml(readiness)}</strong>
    </div>
    <div class="summary-item">
      <span>Generated</span>
      <strong>${escapeHtml(generatedAt)}</strong>
    </div>
  `;
}

function fairValueBar(report, currency) {
  const range = rangeValue(report && report.fair_value_range);
  const current = Number(report && report.current_price);

  if (!range || !Number.isFinite(current)) {
    return `
      <div class="empty-state">
        No valuation range available yet. Run a report to populate the current price and model range.
      </div>
    `;
  }

  const [low, high] = range;
  const span = Math.max(high - low, 1);
  const domainMin = Math.min(low, current) - span * 0.15;
  const domainMax = Math.max(high, current) + span * 0.15;
  const domainSpan = domainMax - domainMin || 1;
  const fillLeft = ((low - domainMin) / domainSpan) * 100;
  const fillWidth = ((high - low) / domainSpan) * 100;
  const markerLeft = Math.min(100, Math.max(0, ((current - domainMin) / domainSpan) * 100));

  return `
    <div class="range-meta">
      <span>Current price</span>
      <strong>${escapeHtml(money(current, currency))}</strong>
    </div>
    <div class="range-track" aria-label="Fair value range">
      <span class="range-fill" style="left: ${fillLeft.toFixed(2)}%; width: ${fillWidth.toFixed(2)}%;"></span>
      <span class="range-marker" style="left: ${markerLeft.toFixed(2)}%;"></span>
    </div>
    <div class="range-labels">
      <span>Low ${escapeHtml(money(low, currency))}</span>
      <span>High ${escapeHtml(money(high, currency))}</span>
    </div>
    <p class="section-note">Base-case analyst range from the latest source packet.</p>
  `;
}

function historyLinks(report) {
  const links = [
    ['Open report', report.report_path],
    ['Markdown', report.markdown_path],
    ['Sources', report.source_packet_path],
  ].filter(([, path]) => path);

  if (!links.length) return '<span class="muted">No files</span>';

  return links.map(([label, path]) => (
    `<a class="mini-link" href="${escapeHtml(reportHref(path))}">${escapeHtml(label)}</a>`
  )).join('');
}

function renderReportHistory(reports, currency) {
  const node = qs('#report-history');
  if (!Array.isArray(reports) || !reports.length) {
    node.innerHTML = '<div class="empty-state">No reports have been generated for this stock yet.</div>';
    return;
  }

  node.innerHTML = reports.map((report) => {
    const range = rangeValue(report.fair_value_range);
    const valuation = range
      ? `${money(range[0], currency)} to ${money(range[1], currency)}`
      : 'No fair-value range';
    const price = Number.isFinite(Number(report.current_price))
      ? money(report.current_price, currency)
      : 'No price';

    return `
      <article class="history-row">
        <div class="history-main">
          <strong>${escapeHtml(formatDate(report.generated_at))}</strong>
          <span>${recommendationPill(report.recommendation)}</span>
          <small>${escapeHtml(text(report.horizon))} horizon | ${escapeHtml(text(report.confidence))} confidence</small>
          <small>${escapeHtml(price)} current | ${escapeHtml(valuation)} fair value</small>
        </div>
        <div class="history-actions">${historyLinks(report)}</div>
      </article>
    `;
  }).join('');
}

function renderSecurity(security, reports = []) {
  const latest = latestReport(reports);
  const identifiers = security.identifiers || {};
  const providerSymbols = security.provider_symbols || {};
  const currency = identifiers.currency || 'USD';

  qs('#stock-title').textContent = text(security.name);
  qs('#stock-subtitle').textContent = `${text(security.id)} | ${text(security.report_profile)}`;

  renderLatestSummary(security, latest);
  qs('#fair-value-visual').innerHTML = fairValueBar(latest, currency);

  renderDefinitionList(qs('#identity-list'), [
    ['Ticker', identifiers.local_ticker],
    ['ISIN', identifiers.isin],
    ['MIC', identifiers.mic],
    ['Currency', identifiers.currency],
    ['FMP', providerSymbols.fmp],
    ['Alpha Vantage', providerSymbols.alpha_vantage],
    ['Massive', providerSymbols.massive],
    ['Last probe', security.last_probe_at],
  ]);

  renderReportHistory(reports, currency);
}

function renderError(title, message) {
  qs('#stock-title').textContent = title;
  qs('#stock-subtitle').textContent = message;
  qs('#validation-status').innerHTML = '<span class="pill missing">missing</span>';
  qs('#latest-summary').innerHTML = '<div class="empty-state error">Could not load latest report.</div>';
  qs('#fair-value-visual').innerHTML = '<div class="empty-state error">Could not load valuation data.</div>';
  qs('#report-history').innerHTML = '<div class="empty-state error">Could not load report history.</div>';
}

async function loadSecurity() {
  const id = currentSecurityId();
  const [securityResponse, reportsResponse] = await Promise.all([
    fetch(`/api/securities/${encodeURIComponent(id)}`),
    fetch(`/api/securities/${encodeURIComponent(id)}/reports`),
  ]);

  const securityBody = await securityResponse.json();
  const reportsBody = await reportsResponse.json();

  if (!securityResponse.ok) {
    renderError('Stock not found', securityBody.error || `No config entry for ${id}.`);
    return;
  }

  const reports = reportsResponse.ok ? reportsBody.reports : [];
  const security = reportsBody.security || securityBody;
  renderSecurity(security, reports);

  if (!reportsResponse.ok) {
    qs('#report-history').innerHTML = `<div class="empty-state error">${escapeHtml(reportsBody.error || 'Could not load report history.')}</div>`;
  }
}

loadSecurity().catch((error) => {
  renderError('Stock detail failed', error.message);
});
