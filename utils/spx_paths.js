// Path helpers for turning request input into file system paths safely.
//
// Every route that builds a path from request data must go through
// resolveInside(): it resolves the segments against a root folder and
// refuses anything that ends up outside it ("../", absolute paths, another
// drive on Windows).

const path = require('path');
const { execFile } = require('child_process');

// Absolute path of `segments` resolved inside `root`, or null when the
// result would be outside `root`. `root` itself is allowed.
function resolveInside(root, ...segments) {
  if (!root) return null;
  const base = path.resolve(String(root));
  const target = path.resolve(base, ...segments.map((s) => (s === undefined || s === null ? '' : String(s))));
  const relative = path.relative(base, target);
  if (relative === '') return target;
  if (path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') return null;
  return target;
}

// True when `name` is usable as a single file or folder name: no path
// separators, not "." or "..", not empty.
function isPlainName(name) {
  const s = String(name === undefined || name === null ? '' : name);
  return s !== '' && s !== '.' && s !== '..' && !/[\\/]/.test(s) && !s.includes('\0');
}

// Opens a folder (or URL) with the OS default handler. execFile runs no
// shell, so the path cannot inject commands; errors are logged.
function openFolderInOS(folder) {
  const logger = require('./logger.js'); // lazy: needs global config
  const opener = { darwin: 'open', win32: 'explorer', linux: 'xdg-open' }[process.platform];
  if (!opener) {
    logger.error('Unknown operating system: ' + process.platform);
    return;
  }
  execFile(opener, [folder], (err) => {
    // explorer.exe exits with 1 even on success.
    if (err && process.platform !== 'win32') logger.warn('Could not open ' + folder + ': ' + err.message);
  });
}

module.exports = { resolveInside, isPlainName, openFolderInOS, openInOS: openFolderInOS };
