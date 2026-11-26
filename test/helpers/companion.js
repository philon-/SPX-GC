// Reproduces the HTTP requests made by the Bitfocus Companion module for SPX,
// "companion-module-spx-graphics-controller" v2.1.0 (MIT):
// https://github.com/bitfocus/companion-module-spx-graphics-controller
//
// Mirrors the module's request.js (buildRequest), so tests exercise SPX the
// way Companion calls it:
//   - plain GET via global fetch (directplayout: POST with a JSON object)
//   - option values URL encoded
//   - with an API key configured: X-API-Key header, plus the apikey query
//     parameter (GET) or body field (POST) for older SPX versions
//   - the response body is read as text; the module checks the status
//     code (401/403 = bad API key), returned here for assertions.
//
// Module v2.0.1 differed: no API key, no URL encoding, invokeTemplateFunction
// threw a ReferenceError before sending, and directplayout posted the text
// box as a JSON string.

const enc = (v) => encodeURIComponent(v === undefined || v === null ? '' : String(v));
const query = (params) => Object.entries(params).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

const PATHS = {
  play: () => '/api/v1/item/play',
  play_ID: (opt) => '/api/v1/item/play/' + enc(opt.id),
  continue: () => '/api/v1/item/continue',
  continue_ID: (opt) => '/api/v1/item/continue/' + enc(opt.id),
  stop: () => '/api/v1/item/stop',
  stop_ID: (opt) => '/api/v1/item/stop/' + enc(opt.id),
  focusFirst: () => '/api/v1/rundown/focusFirst',
  focusNext: () => '/api/v1/rundown/focusNext',
  focusPrevious: () => '/api/v1/rundown/focusPrevious',
  focusLast: () => '/api/v1/rundown/focusLast',
  stopAllLayers: () => '/api/v1/rundown/stopAllLayers',
  openRundown: (opt) => '/api/v1/rundown/load?' + query({ file: opt.rundown }),
  controlRundownItem: (opt) => '/api/v1/controlRundownItemByID?' + query({ file: opt.file, item: opt.id, command: opt.command }),
  invokeTemplateFunction: (opt) =>
    '/api/v1/invokeTemplateFunction?' +
    query({
      playserver: opt.playserver,
      playchannel: opt.playchannel,
      playlayer: opt.playlayer,
      webplayout: opt.webplayout,
      function: opt.customFunction,
      params: opt.params,
    }),
};

function buildRequest(actionId, opt, { host, port, apikey = '' }) {
  const base = `http://${host}:${port}`;
  const headers = apikey ? { 'X-API-Key': apikey } : {};
  if (actionId === 'directplayout') {
    const text = String(opt.body || '').trim();
    const body = JSON.parse(/^[[{]/.test(text) ? text : '{' + text + '}');
    if (apikey) body.apikey = apikey;
    return { url: base + '/api/v1/directplayout', method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  const path = PATHS[actionId];
  if (!path) throw new Error(`Unknown Companion action: ${actionId}`);
  let url = base + path(opt);
  if (apikey) url += (url.includes('?') ? '&' : '?') + 'apikey=' + enc(apikey);
  return { url, method: 'GET', headers };
}

// Default option values of the module's actions.
const DEFAULTS = {
  invokeTemplateFunction: {
    playserver: 'OVERLAY',
    playchannel: '1',
    playlayer: '19',
    webplayout: '19',
    customFunction: 'myCustomTemplateFunction',
    params: 'Hello World',
  },
  directplayout: {
    body: '{"casparServer": "OVERLAY", "casparChannel": "1", "casparLayer": "20", "webplayoutLayer": "20", "relativeTemplatePath": "vendor/pack/templatefile.html", "command": "play"}',
  },
};

// Runs a Companion action against the server listening on `port`.
// `config.apikey`: the module's API key setting.
async function companionAction(port, actionId, options = {}, config = {}) {
  const request = buildRequest(actionId, { ...DEFAULTS[actionId], ...options }, { host: '127.0.0.1', port, ...config });
  const res = await fetch(request.url, request);
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch (e) {
    // not JSON
  }
  return { status: res.status, body, json };
}


// The module's (currently disabled) dynamic presets parse /api/v1/rundown/get
// like this (presets.js, convertRundown). Kept verbatim in behaviour.
function companionConvertRundown(rundown) {
  if (rundown['templates'] == undefined) {
    return [];
  }
  const templates = rundown.templates.filter((template) => template.out == 'manual');
  return templates.map((template) => {
    const fields = template.DataFields.filter((field) => field.ftype == 'textfield');
    return { itemID: template.itemID, title: fields[0].value };
  });
}

module.exports = { companionAction, companionConvertRundown };
