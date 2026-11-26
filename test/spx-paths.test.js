// Unit tests of utils/spx_paths.js resolveInside (no server).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveInside, isPlainName } = require('../utils/spx_paths.js');

describe('resolveInside', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spx-paths-'));
    fs.mkdirSync(path.join(dir, 'root', 'sub'), { recursive: true });
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('allows paths inside root and root itself', () => {
    const root = path.join(dir, 'root');
    assert.equal(resolveInside(root, 'sub', 'a.json'), path.join(root, 'sub', 'a.json'));
    assert.equal(resolveInside(root, root), root);
  });

  it('refuses paths outside root', () => {
    const root = path.join(dir, 'root');
    assert.equal(resolveInside(root, '..'), null);
    assert.equal(resolveInside(root, 'sub', '..', '..', 'x'), null);
    assert.equal(resolveInside(root, path.join(dir, 'rootish')), null, 'prefix of the name is not inside');
    assert.equal(resolveInside(root, path.parse(dir).root), null);
    assert.equal(resolveInside(null, 'x'), null);
  });

  // macOS: /var is a symlink to /private/var, and process.cwd() reports the
  // resolved name. Another name for the root folder must count as inside.
  it('accepts another name of the same root folder (symlink)', (t) => {
    const alias = path.join(dir, 'alias');
    try {
      fs.symlinkSync(path.join(dir, 'root'), alias, 'junction');
    } catch (error) {
      return t.skip('cannot create symlinks here: ' + error.code);
    }
    const root = path.join(dir, 'root');
    assert.equal(resolveInside(root, path.join(alias, 'sub')), path.join(alias, 'sub'));
    assert.equal(resolveInside(root, path.join(alias, 'sub', 'new.json')), path.join(alias, 'sub', 'new.json'), 'file not created yet');
    assert.equal(resolveInside(alias, path.join(root, 'sub')), path.join(root, 'sub'));
    assert.equal(resolveInside(root, path.join(alias, '..', 'x')), null);
  });
});

describe('isPlainName', () => {
  it('accepts names and refuses paths', () => {
    assert.equal(isPlainName('MyFirstRundown.json'), true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../x', 'a\0b', undefined]) {
      assert.equal(isPlainName(bad), false, JSON.stringify(bad));
    }
  });
});
