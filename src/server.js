const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  addSecurity,
  getProviderStatus,
  getSecurity,
  loadWatchlist,
  removeSecurity,
} = require('./configStore');
const { loadProjectEnv } = require('./env');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body too large.'));
        request.destroy();
      }
    });

    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });

    request.on('error', reject);
  });
}

function safeJoin(rootDir, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  const absolutePath = path.join(rootDir, normalized);
  const relative = path.relative(rootDir, absolutePath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return absolutePath;
}

function serveFile(response, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }

  const extension = path.extname(filePath);
  response.writeHead(200, {
    'content-type': MIME_TYPES[extension] || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(response);
}

function sourcePacketPathForReport(projectDir, reportPath) {
  if (!reportPath) return null;
  const reportName = path.basename(reportPath).replace(/-report\.(html|md)$/i, '');
  if (!reportName || reportName === path.basename(reportPath)) return null;
  return path.join(projectDir, 'data', 'source-packets', `${reportName}.json`);
}

function relativePathIfFile(projectDir, relativePath) {
  const absolutePath = path.join(projectDir, relativePath);
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() ? relativePath : null;
}

function metricValue(packetSecurity, metricIds) {
  const metrics = Array.isArray(packetSecurity && packetSecurity.metrics) ? packetSecurity.metrics : [];
  const metric = metrics.find((candidate) => metricIds.includes(candidate.metric_id));
  return metric ? metric.normalized_value : null;
}

function normalizeRecommendation(rawStance) {
  const stance = typeof rawStance === 'string' ? rawStance.trim() : '';
  if (!stance) return { label: 'Not run', raw_stance: null, tone: 'missing' };

  const lower = stance.toLowerCase();
  if (lower === 'buy') return { label: 'Buy', raw_stance: stance, tone: 'buy' };
  if (lower === 'sell' || lower === 'sell / trim' || lower === 'trim') return { label: 'Sell', raw_stance: stance, tone: 'sell' };
  if (lower === 'hold' || lower === 'hold / accumulate on pullbacks') return { label: 'Hold', raw_stance: stance, tone: 'hold' };
  if (lower === 'no model stance' || lower === 'monitor' || lower === 'monitor only') return { label: 'Monitor', raw_stance: stance, tone: 'monitor' };

  return { label: stance, raw_stance: stance, tone: 'neutral' };
}

function readRecommendation(projectDir, security) {
  const sourcePacketPath = sourcePacketPathForReport(projectDir, security.last_report_path);
  if (!sourcePacketPath || !fs.existsSync(sourcePacketPath)) return normalizeRecommendation(null);

  try {
    const packet = JSON.parse(fs.readFileSync(sourcePacketPath, 'utf8'));
    const packetSecurity = (packet.securities || []).find((candidate) => candidate.security_id === security.id)
      || (packet.securities || [])[0];
    return normalizeRecommendation(packetSecurity && packetSecurity.analysis_model && packetSecurity.analysis_model.stance);
  } catch {
    return normalizeRecommendation(null);
  }
}

function enrichSecurity(projectDir, security) {
  return {
    ...security,
    recommendation: readRecommendation(projectDir, security),
  };
}

function enrichWatchlist(projectDir) {
  const watchlist = loadWatchlist(projectDir);
  return {
    ...watchlist,
    securities: watchlist.securities.map((security) => enrichSecurity(projectDir, security)),
  };
}

function readSecurityReportHistory(projectDir, security) {
  const packetDir = path.join(projectDir, 'data', 'source-packets');
  if (!fs.existsSync(packetDir)) return [];

  return fs.readdirSync(packetDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      const sourcePacketPath = path.join(packetDir, fileName);
      try {
        const packet = JSON.parse(fs.readFileSync(sourcePacketPath, 'utf8'));
        const packetSecurity = (packet.securities || []).find((candidate) => candidate.security_id === security.id);
        if (!packetSecurity) return null;

        const id = path.basename(fileName, '.json');
        const analysis = packetSecurity.analysis_model || {};
        return {
          id,
          generated_at: packet.generated_at || null,
          recommendation: normalizeRecommendation(analysis.stance),
          horizon: analysis.horizon || null,
          confidence: analysis.confidence || null,
          readiness_label: analysis.readiness_label || null,
          current_price: metricValue(packetSecurity, ['current_share_price', 'current_price']),
          fair_value_range: metricValue(packetSecurity, ['base_fair_value_range']),
          report_path: relativePathIfFile(projectDir, `reports/${id}-report.html`),
          markdown_path: relativePathIfFile(projectDir, `reports/${id}-report.md`),
          source_packet_path: `data/source-packets/${fileName}`,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const dateCompare = String(right.generated_at || '').localeCompare(String(left.generated_at || ''));
      return dateCompare || right.id.localeCompare(left.id);
    });
}

async function handleApi({ request, response, projectDir, env, pathname }) {
  if (request.method === 'GET' && pathname === '/api/securities') {
    sendJson(response, 200, enrichWatchlist(projectDir));
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/provider-status') {
    sendJson(response, 200, getProviderStatus(env));
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/securities') {
    try {
      const input = await parseBody(request);
      sendJson(response, 201, addSecurity(projectDir, input));
    } catch (error) {
      const statusCode = error.message.includes('already exists') ? 409 : 400;
      sendJson(response, statusCode, { error: error.message });
    }
    return true;
  }

  const reportHistoryMatch = pathname.match(/^\/api\/securities\/([^/]+)\/reports$/);
  if (reportHistoryMatch && request.method === 'GET') {
    const id = decodeURIComponent(reportHistoryMatch[1]);
    const security = getSecurity(projectDir, id);
    if (!security) {
      sendJson(response, 404, { error: `Security not found: ${id}` });
      return true;
    }
    sendJson(response, 200, {
      security: enrichSecurity(projectDir, security),
      reports: readSecurityReportHistory(projectDir, security),
    });
    return true;
  }

  const securityMatch = pathname.match(/^\/api\/securities\/([^/]+)$/);
  if (securityMatch) {
    const id = decodeURIComponent(securityMatch[1]);

    if (request.method === 'GET') {
      const security = getSecurity(projectDir, id);
      if (!security) {
        sendJson(response, 404, { error: `Security not found: ${id}` });
        return true;
      }
      sendJson(response, 200, enrichSecurity(projectDir, security));
      return true;
    }

    if (request.method === 'DELETE') {
      try {
        sendJson(response, 200, removeSecurity(projectDir, id));
      } catch (error) {
        sendJson(response, 404, { error: error.message });
      }
      return true;
    }
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API route not found.' });
    return true;
  }

  return false;
}

function createServer(options = {}) {
  const projectDir = options.projectDir || process.cwd();
  const publicDir = options.publicDir || path.join(projectDir, 'public');
  const env = options.env || loadProjectEnv(projectDir);

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURI(url.pathname);
      const handledApi = await handleApi({ request, response, projectDir, env, pathname });

      if (handledApi) return;

      if (request.method !== 'GET') {
        sendText(response, 405, 'Method not allowed');
        return;
      }

      if (pathname === '/') {
        serveFile(response, path.join(publicDir, 'index.html'));
        return;
      }

      if (pathname.startsWith('/stock/')) {
        serveFile(response, path.join(publicDir, 'stock.html'));
        return;
      }

      if (pathname.startsWith('/assets/')) {
        serveFile(response, safeJoin(publicDir, pathname.slice(1)));
        return;
      }

      if (pathname.startsWith('/reports/')) {
        serveFile(response, safeJoin(projectDir, pathname.slice(1)));
        return;
      }

      if (pathname.startsWith('/data/source-packets/')) {
        serveFile(response, safeJoin(projectDir, pathname.slice(1)));
        return;
      }

      sendText(response, 404, 'Not found');
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

function startServer() {
  const port = Number(process.env.PORT || 4173);
  const server = createServer();

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    console.log(`Stock Analyzer local app: http://${address.address}:${address.port}/`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer,
};
