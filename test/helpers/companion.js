// Reproduces the HTTP requests made by the Bitfocus Companion module for SPX,
// "companion-module-spx-graphics-controller" v2.0.1 (MIT):
// https://github.com/bitfocus/companion-module-spx-graphics-controller
//
// The URL templates below are copied from the module's doAction() in
// actions.js, including its quirks, so tests exercise SPX exactly the way
// Companion calls it:
//   - always plain GET via global fetch (directplayout aside, not covered here)
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
};

// Runs a Companion action against the server listening on `port`.
async function companionAction(port, actionId, options = {}) {
  const build = URLS[actionId];
  if (!build) throw new Error(`Unknown Companion action: ${actionId}`);
  const res = await fetch(build('127.0.0.1', port, options));
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
