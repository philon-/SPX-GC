// Unit tests of utils/rundown_store.js (no server).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../utils/rundown_store.js');

function fakeDisk(files = {}) {
  const disk = { files: { ...files }, writes: [] };
  disk.read = async (file) => (file in disk.files ? JSON.parse(JSON.stringify(disk.files[file])) : null);
  disk.write = async (file, data) => {
    disk.writes.push(file);
    disk.files[file] = JSON.parse(JSON.stringify(data));
  };
  return disk;
}

describe('rundown store', () => {
  it('keeps one entry per file', async () => {
    const disk = fakeDisk({ '/r/a.json': { templates: ['a'] }, '/r/b.json': { templates: ['b'] } });
    const store = createStore(disk);
    const a = await store.load('/r/a.json');
    const b = await store.load('/r/b.json');
    assert.deepEqual(a.templates, ['a']);
    assert.deepEqual(b.templates, ['b']);
    assert.equal(store.get('/r/a.json'), a);
    assert.equal(store.get('/r/./a.json'), a, 'paths are normalised');
  });

  it('load uses memory, unless fresh', async () => {
    const disk = fakeDisk({ '/r/a.json': { v: 1 } });
    const store = createStore(disk);
    (await store.load('/r/a.json')).v = 2; // in-memory change
    disk.files['/r/a.json'] = { v: 3 };
    assert.equal((await store.load('/r/a.json')).v, 2);
    assert.equal((await store.load('/r/a.json', { fresh: true })).v, 3);
  });

  it('update saves, or skips saving when mutate returns false; null for a missing file', async () => {
    const disk = fakeDisk({ '/r/a.json': { v: 1 } });
    const store = createStore(disk);
    await store.update('/r/a.json', (d) => {
      d.v = 2;
    });
    assert.equal(disk.files['/r/a.json'].v, 2);
    await store.update('/r/a.json', (d) => {
      d.v = 3;
      return false;
    });
    assert.equal(disk.files['/r/a.json'].v, 2);
    assert.equal(store.get('/r/a.json').v, 3);
    assert.equal(await store.update('/r/missing.json', () => {}), null);
  });

  it('runs work on the same file one at a time, in order', async () => {
    const store = createStore(fakeDisk());
    const log = [];
    const step = (name, ms) => store.withLock('/r/a.json', async () => {
      log.push(name + ' start');
      await new Promise((r) => setTimeout(r, ms));
      log.push(name + ' end');
    });
    await Promise.all([step('1', 30), step('2', 1), step('3', 1)]);
    assert.deepEqual(log, ['1 start', '1 end', '2 start', '2 end', '3 start', '3 end']);
  });

  it('a failed step does not block the queue', async () => {
    const store = createStore(fakeDisk());
    await assert.rejects(store.withLock('/r/a.json', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await store.withLock('/r/a.json', async () => 'next'), 'next');
  });

  it('different files do not wait for each other', async () => {
    const store = createStore(fakeDisk());
    let release;
    const blocked = store.withLock('/r/a.json', () => new Promise((r) => (release = r)));
    assert.equal(await store.withLock('/r/b.json', async () => 'b done'), 'b done');
    release();
    await blocked;
  });

  it('current is the rundown last opened; removing it clears current', async () => {
    const disk = fakeDisk({ '/r/a.json': { n: 'a' }, '/r/b.json': { n: 'b' } });
    const store = createStore(disk);
    store.set('/r/a.json', await disk.read('/r/a.json'));
    store.setCurrent('/r/a.json');
    await store.load('/r/b.json'); // e.g. an API call on b
    assert.equal(store.current().n, 'a');
    assert.ok(store.isCurrent('/r/a.json'));
    store.remove('/r/a.json');
    assert.equal(store.current(), null);
  });
});
