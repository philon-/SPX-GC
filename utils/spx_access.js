// Access control for SPX: every "may this request do this?" decision lives
// here, so routes only pick a middleware instead of re-implementing checks.
//
// Three independent questions:
//
// 1. Is the request cross-site? (refuseCrossSite, global)
//    A web page on another site must not be able to drive SPX through the
//    operator's browser (a plain <img src="http://localhost:5656/...">
//    reaches the server). Browsers mark such requests with an Origin that
//    differs from Host, or with Sec-Fetch-Site. Non-browser clients (Stream
//    Deck, Companion, scripts) send neither, so they are not affected.
//
// 2. May it use the UI's internal endpoints? (requireUiAccess)
//    Follows the login setting: with a username configured, a logged-in
//    session (or a valid API key) is required; without one, SPX is open.
//
// 3. May it use the public API /api/v1? (requireApiAccess)
//    Follows the API key setting: a valid key, or a logged-in session.
//
// Config keys (config.general):
//   username / password ...... login (password stored hashed, see spx.hash)
//   apikey ................... key for the public API
//   allowedOrigins ........... origins allowed to call SPX from a browser
//                              (array or comma separated string, "*" = all)
//   allowCrossSiteRequests ... true disables the cross-site refusal

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const logger = require('./logger.js');

// Endpoints that templates and renderers call. Renderers (OBS, CasparCG)
// have no login session and may run from another origin, so these stay
// callable from anywhere. They must remain safe to call unauthenticated.
const TEMPLATE_ENDPOINTS = new Set([
  '/api/logger',
  '/api/readexceldata',
  '/api/v1/feedproxy',
  '/api/v1/version',
]);

const LOG_LEVELS = new Set(['error', 'warn', 'info', 'verbose', 'debug']);

function general() {
  return (global.config && global.config.general) || {};
}

function header(req, name) {
  const value = req.headers ? req.headers[name] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

// Express matches routes case-insensitively and ignores a trailing slash.
function normalizedPath(req) {
  const p = String(req.path || (req.url || '').split('?')[0] || '/').toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

function allowedOrigins() {
  const value = general().allowedOrigins;
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list.map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean);
}

function isOriginAllowed(origin) {
  if (!origin) return false;
  const list = allowedOrigins();
  return list.includes('*') || list.includes(String(origin).replace(/\/+$/, ''));
}

function crossSiteAllowedByConfig() {
  const v = general().allowCrossSiteRequests;
  return v === true || v === 'true';
}

// True when a browser sent this request on behalf of a page from another
// origin. Works on Express requests and on raw socket.io handshakes.
function isCrossSite(req) {
  const origin = header(req, 'origin');
  if (origin) {
    if (origin === 'null') return true; // file://, sandboxed frames
    try {
      return new URL(origin).host.toLowerCase() !== String(header(req, 'host') || '').toLowerCase();
    } catch (e) {
      return true;
    }
  }
  const site = header(req, 'sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
}

// --- API key -----------------------------------------------------------------

function requestApiKey(req) {
  const value = header(req, 'x-api-key') || (req.body && req.body.apikey) || (req.query && req.query.apikey) || '';
  return String(Array.isArray(value) ? value[0] : value);
}

function safeEqual(a, b) {
  // Hash first so lengths match and the comparison time does not depend on the key.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isApiKeyValid(req) {
  const configured = general().apikey;
  const given = requestApiKey(req);
  return !!configured && !!given && safeEqual(given, configured);
}

// --- Login session -------------------------------------------------------------

function isAuthEnabled() {
  return !!general().username;
}

function hasLoginSession(req) {
  const user = req.session && req.session.user;
  return isAuthEnabled() && !!user && user === general().username;
}

function wantsHtml(req) {
  return req.method === 'GET' && String(header(req, 'accept') || '').includes('text/html');
}

// --- Middlewares -----------------------------------------------------------------

function refuseCrossSite(req, res, next) {
  if (!isCrossSite(req)) return next();
  if (crossSiteAllowedByConfig() || isOriginAllowed(header(req, 'origin'))) return next();
  const p = normalizedPath(req);
  if (TEMPLATE_ENDPOINTS.has(p)) return next();
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && !p.startsWith('/api') && !p.startsWith('/ccg')) return next(); // pages and static files
  if (isApiKeyValid(req)) return next();
  logger.warn('Refused cross-site ' + req.method + ' ' + p + ' (origin ' + (header(req, 'origin') || header(req, 'sec-fetch-site')) + ').');
  return res.status(403).json({
    error: 'Cross-site request refused. Send a valid API key, or add the origin to config.general.allowedOrigins.',
  });
}

// CORS: template endpoints answer any origin (as before); everything else
// only the configured allowedOrigins.
const corsAnyOrigin = cors();
const corsConfigured = cors({ origin: (origin, cb) => cb(null, isOriginAllowed(origin)) });
function corsPolicy(req, res, next) {
  return TEMPLATE_ENDPOINTS.has(normalizedPath(req)) ? corsAnyOrigin(req, res, next) : corsConfigured(req, res, next);
}

function requireUiAccess(req, res, next) {
  if (!isAuthEnabled() || hasLoginSession(req) || isApiKeyValid(req)) return next();
  logger.verbose('Refused ' + req.method + ' ' + normalizedPath(req) + ': login required.');
  if (wantsHtml(req)) return res.redirect('/login');
  return res.status(401).json({ error: 'Login required.' });
}

function apiDecision(req) {
  if (isApiKeyValid(req)) return [true, 'API key matches. Access allowed.'];
  if (hasLoginSession(req)) return [true, 'Logged-in session. Access allowed.'];
  const { username, apikey } = general();
  if (username && !apikey) {
    return [false, 'Warning! When username is configured in SPX, apikey is required then also.'];
  }
  if (!apikey) return [true, 'No api key SPX in config, allow all.'];
  if (!requestApiKey(req)) {
    return [false, 'API key configured in SPX, but apikey missing from the ' + req.method + ' API request. Access denied.'];
  }
  return [false, 'API key does not match. Access denied.'];
}

function requireApiAccess(req, res, next) {
  const [allowed, message] = apiDecision(req);
  if (allowed) {
    logger.debug(message);
    return next();
  }
  logger.warn(message);
  return res.status(401).json({ error: message });
}

// --- Socket.IO -----------------------------------------------------------------

// May this socket send messages that are relayed to every renderer and
// controller (SPXWebRendererMessage)? Renderers execute what they get, so
// with login on this needs a logged-in session; with login off, a socket
// opened by a page from another site is refused.
function mayRelayFromSocket(socket) {
  const req = socket.request;
  if (isAuthEnabled()) return hasLoginSession(req);
  return !isCrossSite(req) || crossSiteAllowedByConfig() || isOriginAllowed(header(req, 'origin'));
}

// --- Misc ------------------------------------------------------------------------

function isLogLevel(level) {
  return LOG_LEVELS.has(level);
}

// Remove API keys from a URL before it is logged.
function redactApiKey(url) {
  return String(url || '').replace(/([?&]apikey=)[^&#]*/gi, '$1REDACTED');
}

// Session secret: random per install, kept next to the app (not in
// config.json, which the config UI rewrites and shows).
function loadSessionSecret(folder) {
  const file = path.join(folder, '.spx_session_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (e) {
    // not created yet
  }
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (e) {
    logger.warn('Could not save session secret to ' + file + ' (logins will not survive a restart): ' + e);
  }
  return secret;
}

module.exports = {
  refuseCrossSite,
  corsPolicy,
  requireUiAccess,
  requireApiAccess,
  mayRelayFromSocket,
  isCrossSite,
  isApiKeyValid,
  hasLoginSession,
  isAuthEnabled,
  isLogLevel,
  redactApiKey,
  loadSessionSecret,
  TEMPLATE_ENDPOINTS,
};
