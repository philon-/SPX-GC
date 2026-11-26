// Escaping for HTML that is built as strings (Handlebars helpers in
// server.js and a few utilities). Anything that comes from templates,
// rundowns, project or app config, or file names must go through these.

// Text or attribute value: <, >, &, " and ' become entities.
function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A JavaScript string literal for use inside an HTML attribute, e.g.
// onclick="f(' + jsString(name) + ')".
function jsString(value) {
  return escapeHtml(JSON.stringify(String(value === undefined || value === null ? '' : value)));
}

module.exports = { escapeHtml, jsString };
