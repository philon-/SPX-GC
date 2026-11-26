// In-memory rundown state, one entry per rundown file.
//
// Replaces the single global.rundownData. That global held "whichever
// rundown was touched last", but playout read it for any rundown and then
// wrote it to the file it was asked about, so with two rundowns in use one
// could overwrite the other (duplicated rundowns share item IDs, so nothing
// failed loudly).
//
// Rules:
// - A rundown's entry is the current truth while SPX has it in memory: it
//   holds on-air state that is not always written to disk (e.g. continue,
//   play once).
// - Opening a rundown in the controller reloads it from disk (load with
//   fresh: true), as before.
// - Every change to a rundown goes through update(): read (memory, or disk
//   when not in memory), modify, optionally save, all under that file's
//   lock, so concurrent requests on the same file run one after another.
// - current() is the rundown last opened in a controller. That is what
//   /api/v1/rundown/get returns and what "the open rundown" means.

const path = require('path');

function createStore({ read, write } = {}) {
  const entries = new Map(); // key -> rundown data
  const locks = new Map(); // key -> tail promise of the queue
  let currentKey = null;

  const readFile = read || ((file) => require('./spx_server_functions.js').readJson(file));
  const writeFile = write || ((file, data) => require('./spx_server_functions.js').writeFile(file, data));

  function key(file) {
    const resolved = path.resolve(String(file));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function get(file) {
    return entries.get(key(file)) || null;
  }

  function set(file, data) {
    entries.set(key(file), data);
    return data;
  }

  function remove(file) {
    const k = key(file);
    entries.delete(k);
    if (currentKey === k) currentKey = null;
  }

  // The entry of `file`, read from disk when not in memory (or always with
  // fresh). Resolves null when the file does not exist.
  async function load(file, { fresh = false } = {}) {
    const k = key(file);
    if (!fresh && entries.has(k)) return entries.get(k);
    const data = await readFile(file);
    if (data === null || data === undefined) {
      entries.delete(k);
      return null;
    }
    entries.set(k, data);
    return data;
  }

  async function save(file) {
    const data = get(file);
    if (data) await writeFile(file, data);
  }

  // Runs fn() after earlier queued work on the same file has finished.
  function withLock(file, fn) {
    const k = key(file);
    const previous = locks.get(k) || Promise.resolve();
    const run = previous.then(() => fn());
    const tail = run.catch(() => {}); // a failed step must not block the queue
    locks.set(k, tail);
    tail.then(() => {
      if (locks.get(k) === tail) locks.delete(k);
    });
    return run;
  }

  // Loads the rundown, lets mutate(data) change it in place and saves it
  // (unless mutate returns false), all under the file's lock. Resolves with
  // the data, or null when the file does not exist.
  function update(file, mutate, { fresh = false } = {}) {
    return withLock(file, async () => {
      const data = await load(file, { fresh });
      if (!data) return null;
      const result = await mutate(data);
      if (result !== false) await writeFile(file, data);
      return data;
    });
  }

  function setCurrent(file) {
    currentKey = key(file);
  }

  function current() {
    return currentKey ? entries.get(currentKey) || null : null;
  }

  function isCurrent(file) {
    return currentKey !== null && currentKey === key(file);
  }

  function clear() {
    entries.clear();
    currentKey = null;
  }

  return { get, set, remove, load, save, update, withLock, setCurrent, current, isCurrent, clear };
}

module.exports = createStore();
module.exports.createStore = createStore;
