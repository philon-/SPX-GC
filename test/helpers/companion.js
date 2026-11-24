// Reproduces the HTTP requests made by the Bitfocus Companion module for SPX,
// "companion-module-spx-graphics-controller" v2.0.1 (MIT):
// https://github.com/bitfocus/companion-module-spx-graphics-controller
//
// The URL templates below are copied from the module's doAction() in
// actions.js, including its quirks, so tests exercise SPX exactly the way
// Companion calls it:
//   - plain GET via global fetch (directplayout: POST with a JSON body)
//   - no API key is ever sent (the module has no apikey setting)
//   - option values are interpolated without URL encoding
//   - the response body is read as text; the status code is ignored by the
//     module, but returned here so tests can assert on it.

const URLS = {
  play: (h, p) => `http://${h}:${p}/api/v1/item/play`,
  play_ID: (h, p, opt) => `http://${h}:${p}/api/v1/item/play/${opt.id}`,
  continue: (h, p) => `http://${h}:${p}/api/v1/item/continue`,
  continue_ID: (h, p, opt) => `http://${h}:${p}/api/v1/item/continue/${opt.id}`,
  stop: (h, p) => `http://${h}:${p}/api/v1/item/stop`,
  stop_ID: (h, p, opt) => `http://${h}:${p}/api/v1/item/stop/${opt.id}`,
  focusFirst: (h, p) => `http://${h}:${p}/api/v1/rundown/focusFirst`,
  focusNext: (h, p) => `http://${h}:${p}/api/v1/rundown/focusNext`,
  focusPrevious: (h, p) => `http://${h}:${p}/api/v1/rundown/focusPrevious`,
  focusLast: (h, p) => `http://${h}:${p}/api/v1/rundown/focusLast`,
  stopAllLayers: (h, p) => `http://${h}:${p}/api/v1/rundown/stopAllLayers`,
  openRundown: (h, p, opt) => `http://${h}:${p}/api/v1/rundown/load?file=${opt.rundown}`,
  controlRundownItem: (h, p, opt) =>
    `http://${h}:${p}/api/v1/controlRundownItemByID?file=${opt.file}&item=${opt.id}&command=${opt.command}`,

  // Not working in module v2.0.1 (it throws a ReferenceError before sending).
  // This is the request of the patched module: the action's options, URL
  // encoded.
  invokeTemplateFunction: (h, p, opt) => {
    const q = new URLSearchParams({
      playserver: opt.playserver,
      playchannel: opt.playchannel,
      playlayer: opt.playlayer,
      webplayout: opt.webplayout,
      function: opt.customFunction,
      params: opt.params,
    });
    return `http://${h}:${p}/api/v1/invokeTemplateFunction?${q}`;
  },

  // Not working in module v2.0.1 (it sends the text box as a JSON string,
  // which SPX rejects). The patched module parses the text box as JSON and
  // posts the object.
  directplayout: (h, p, opt) => ({
    url: `http://${h}:${p}/api/v1/directplayout`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.parse(opt.body)),
  }),
};

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
async function companionAction(port, actionId, options = {}) {
  const build = URLS[actionId];
  if (!build) throw new Error(`Unknown Companion action: ${actionId}`);
  const request = build('127.0.0.1', port, { ...DEFAULTS[actionId], ...options });
  const res = typeof request === 'string' ? await fetch(request) : await fetch(request.url, request);
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
