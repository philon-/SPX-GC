// Failures are reported (not swallowed or left hanging), and SPX recovers
// from them.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');

const PROJECT = 'MyFirstProject';
const RUNDOWN = 'MyFirstRundown';
const ITEM = '1773083297691';

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Failed rundown writes', () => {
  let spx;
  let dataDir;
  let file;
  before(async () => {
    spx = await startServer();
    dataDir = path.join(spx.dir, 'DATAROOT', PROJECT, 'data');
    file = path.join(dataDir, RUNDOWN + '.json');
    // Opened in the controller, so the save works on the in-memory copy and
    // only the write to disk fails.
    assert.equal((await fetch(`${spx.baseUrl}/gc/${PROJECT}/${RUNDOWN}`)).status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  const save = (value) =>
    post(`${spx.baseUrl}/gc/saveItemChanges`, { rundownfile: file, epoch: ITEM, DataFields: [{ field: 'f0', value }] });

  it('answer 500 instead of hanging, and leave no temp files', async () => {
    // A folder where the rundown file should be: writing it fails on every
    // OS (folder permissions do not work for this on Windows).
    const moved = file + '.moved';
    fs.renameSync(file, moved);
    fs.mkdirSync(file);
    try {
      const res = await save('not saved');
      assert.equal(res.status, 500);
      assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left');
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(moved, file);
    }
  });

  it('do not block later writes to the same rundown', async () => {
    const res = await save('saved later');
    assert.equal(res.status, 200);
    const field = spx.readRundown(PROJECT, RUNDOWN).templates.find((t) => t.itemID === ITEM).DataFields.find((f) => f.field === 'f0');
    assert.equal(field.value, 'saved later');
  });
});

describe('Playout of a missing template', () => {
  it('is refused before anything goes on air', async () => {
    const spx = await startServer();
    try {
      const file = path.join(spx.dir, 'DATAROOT', PROJECT, 'data', RUNDOWN + '.json');
      const changed = await fetch(
        `${spx.baseUrl}/api/v1/changeItemData?rundownfile=${encodeURIComponent(file)}&ID=${ITEM}&key=relpath&newValue=/missing/template.html`
      );
      assert.equal(changed.status, 200);
      const sent = spx.listener.collect('SPXMessage2Client', 500);
      const res = await post(`${spx.baseUrl}/gc/playout`, { datafile: file, epoch: ITEM, command: 'play' });
      assert.equal(res.status, 500);
      assert.match(await res.text(), /Template not found/);
      assert.deepEqual((await sent).filter((m) => m.spxcmd === 'playTemplate'), []);
      assert.equal(spx.readRundown(PROJECT, RUNDOWN).templates.find((t) => t.itemID === ITEM).onair, 'false');
    } finally {
      await spx.stop();
    }
  });
});

describe('Saving the app config', () => {
  it('removes every CasparCG server row with missing data (and only those)', async () => {
    const spx = await startServer();
    try {
      const config = JSON.parse(fs.readFileSync(path.join(spx.dir, 'config.json'), 'utf8'));
      config.casparcg.servers = [
        { name: '', host: '', port: '' },
        { name: '', host: '', port: '' },
        { name: 'KEEP', host: '127.0.0.1', port: '1' },
      ];
      const res = await post(`${spx.baseUrl}/config`, config);
      assert.equal(res.status, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(spx.dir, 'config.json'), 'utf8'));
      assert.deepEqual(saved.casparcg.servers.map((s) => s.name), ['KEEP']);
    } finally {
      await spx.stop();
    }
  });
});

describe('CasparCG connection', () => {
  let spx;
  before(async () => {
    spx = await startServer({ casparcg: true });
  });
  after(async () => {
    await spx?.stop();
  });

  it('reconnects after CasparCG drops the connection, and playout works again', async () => {
    await spx.casparcg.dropConnections();
    await spx.casparcg.connected(10000);
    const file = path.join(spx.dir, 'DATAROOT', PROJECT, 'data', RUNDOWN + '.json');
    const cmd = spx.casparcg.next((line) => line.startsWith('CG '));
    const res = await post(`${spx.baseUrl}/gc/playout`, { datafile: file, epoch: ITEM, command: 'play' });
    assert.equal(res.status, 200);
    assert.match(await cmd, /^CG 1-\d+ ADD 1 /);
  });

  it('/CCG/requestInfo answers 404 for an unknown server and 400 without a command', async () => {
    assert.equal((await fetch(`${spx.baseUrl}/CCG/requestInfo?server=NOPE&command=INFO`)).status, 404);
    assert.equal((await fetch(`${spx.baseUrl}/CCG/requestInfo?server=OVERLAY`)).status, 400);
  });
});
