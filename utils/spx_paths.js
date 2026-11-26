// Path helpers for turning request input into file system paths safely.
//
// Every route that builds a path from request data must go through
// resolveInside(): it resolves the segments against a root folder and
// refuses anything that ends up outside it ("../", absolute paths, another
// drive on Windows).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function isWithin(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}

// Real path (symlinks and Windows short names resolved) of `p`, also when
// `p` does not exist yet: its nearest existing parent is resolved and the
// rest appended.
function realPath(p) {
  let existing = p;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch (error) {
      const parent = path.dirname(existing);
      if (parent === existing) return p;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

// Absolute path of `segments` resolved inside `root`, or null when the
// result would be outside `root`. `root` itself is allowed.
//
// Checked by name first (so a symlinked folder inside root, e.g. a template
// pack, is allowed), then by real path, so that another name for the same
// folder counts as inside (macOS /var -> /private/var, Windows short names).
function resolveInside(root, ...segments) {
  if (!root) return null;
  const base = path.resolve(String(root));
  const target = path.resolve(base, ...segments.map((s) => (s === undefined || s === null ? '' : String(s))));
  if (isWithin(base, target)) return target;
  if (isWithin(realPath(base), realPath(target))) return target;
  return null;
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
