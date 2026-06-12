const state = {
  watchlist: null,
  providers: null,
};

function qs(selector) {
  return document.querySelector(selector);
}

function text(value, fallback = 'N/A') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function escapeHtml(value, fallback = 'N/A') {
  return text(value, fallback).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function classToken(value, fallback = 'missing') {
  const token = text(value, fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
  return token || fallback;
}

function reportHref(path) {
  if (!path) return null;
  return path.startsWith('/') ? path : `/${path}`;
}

function setMessage(message, isError = false) {
  const node = qs('#form-message');
  node.textContent = message || '';
  node.classList.toggle('error', isError);
}

function renderProviderStatus(status) {
  const labels = [
    ['FMP', status.fmp],
    ['Alpha Vantage', status.alpha_vantage],
    ['Massive', status.massive],
  ];

  qs('#provider-status').innerHTML = labels
    .map(([label, enabled]) => `<span class="pill ${enabled ? 'ok' : 'missing'}">${escapeHtml(label)}: ${enabled ? 'set' : 'missing'}</span>`)
    .join('');
}

function recommendationPill(security) {
  const recommendation = security.recommendation || { label: 'Not run', tone: 'missing' };
  return `<span class="pill recommendation ${classToken(recommendation.tone)}">${escapeHtml(recommendation.label, 'Not run')}</span>`;
}

function securityRow(security) {
  const href = `/stock/${encodeURIComponent(security.id)}`;
  const lastReport = reportHref(security.last_report_path);
  const reportCell = lastReport
    ? `<a href="${escapeHtml(lastReport)}" class="table-link" data-stop-row>Open report</a>`
    : '<span class="muted">No report</span>';

  return `
    <tr class="security-row" data-href="${escapeHtml(href)}">
      <td data-label="Company">
        <a href="${escapeHtml(href)}" class="company-link">${escapeHtml(security.name)}</a>
        <span class="row-subtitle">${escapeHtml(security.report_profile)}</span>
      </td>
      <td data-label="ISIN">${escapeHtml(security.identifiers && security.identifiers.isin)}</td>
      <td data-label="MIC">${escapeHtml(security.identifiers && security.identifiers.mic)}</td>
      <td data-label="Ticker">${escapeHtml(security.identifiers && security.identifiers.local_ticker)}</td>
      <td data-label="Recommendation">${recommendationPill(security)}</td>
      <td data-label="Status"><span class="pill neutral">${escapeHtml(security.validation_status)}</span></td>
      <td data-label="Last report">${reportCell}</td>
      <td data-label="Actions">
        <button class="danger-button" type="button" data-remove-id="${escapeHtml(security.id)}">Remove</button>
      </td>
    </tr>
  `;
}

function renderWatchlist(watchlist) {
  const body = qs('#watchlist-body');

  if (!watchlist.securities.length) {
    body.innerHTML = qs('#empty-row-template').innerHTML;
    return;
  }

  body.innerHTML = watchlist.securities.map(securityRow).join('');
}

async function loadWatchlist() {
  const [watchlistResponse, providerResponse] = await Promise.all([
    fetch('/api/securities'),
    fetch('/api/provider-status'),
  ]);

  if (!watchlistResponse.ok) throw new Error('Could not load watchlist.');
  if (!providerResponse.ok) throw new Error('Could not load provider status.');

  state.watchlist = await watchlistResponse.json();
  state.providers = await providerResponse.json();
  renderWatchlist(state.watchlist);
  renderProviderStatus(state.providers);
}

function formPayload(form) {
  const data = new FormData(form);
  return {
    name: data.get('name'),
    report_profile: data.get('report_profile'),
    identifiers: {
      isin: data.get('isin'),
      mic: data.get('mic'),
      local_ticker: data.get('local_ticker'),
      currency: data.get('currency'),
    },
  };
}

async function addSecurity(event) {
  event.preventDefault();
  setMessage('');

  const form = event.currentTarget;
  const response = await fetch('/api/securities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(formPayload(form)),
  });
  const body = await response.json();

  if (!response.ok) {
    setMessage(body.error || 'Could not add stock.', true);
    return;
  }

  form.reset();
  setMessage(`Added ${body.name}.`);
  await loadWatchlist();
}

async function removeSecurity(id) {
  const response = await fetch(`/api/securities/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  const body = await response.json();

  if (!response.ok) {
    setMessage(body.error || 'Could not remove stock.', true);
    return;
  }

  setMessage(`Removed ${body.name}.`);
  await loadWatchlist();
}

function updateAddStockSummary(details) {
  const action = qs('.summary-action');
  if (action) action.textContent = details && details.open ? 'Close form' : 'Open form';
}

function setupEvents() {
  const addStockDetails = qs('details.add-card');
  if (addStockDetails) {
    updateAddStockSummary(addStockDetails);
    addStockDetails.addEventListener('toggle', () => updateAddStockSummary(addStockDetails));
  }

  qs('#add-security-form').addEventListener('submit', addSecurity);
  qs('#refresh-button').addEventListener('click', loadWatchlist);

  qs('#watchlist-body').addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-id]');
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      removeSecurity(removeButton.dataset.removeId);
      return;
    }

    if (event.target.closest('[data-stop-row]')) return;

    const row = event.target.closest('[data-href]');
    if (row) window.location.href = row.dataset.href;
  });
}

setupEvents();
loadWatchlist().catch((error) => {
  qs('#watchlist-body').innerHTML = `<tr><td colspan="8" class="empty-state error">${error.message}</td></tr>`;
});
