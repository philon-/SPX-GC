// POST /api/v1/directplayout plays/continues/stops a template with given
// data, without a rundown item, and can save the data to a rundown item.
// Companion action "directplayout" (patched module request shape).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');
const { openController } = require('./helpers/controller');
const { companionAction } = require('./helpers/companion');

const TEMPLATE = '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html';
const ITEM = '1773083297691'; // MyFirstRundown item using TEMPLATE, f0 = "Headquarters"

const direct = (spx, body) =>
  companionAction(spx.port, 'directplayout', { body: JSON.stringify(body) });

const play = (extra = {}) => ({
  casparServer: 'OVERLAY',
  casparChannel: '1',
  casparLayer: '20',
  webplayoutLayer: '4',
  relativeTemplatePath: TEMPLATE,
  out: 'manual',
  DataFields: [{ field: 'f0', value: 'Breaking' }],
  command: 'play',
  ...extra,
});

const readItem = (spx, rundown, itemID) => {
  const file = path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'data', `${rundown}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).templates.find((t) => t.itemID === itemID);
};
const f0 = (item) => item.DataFields.find((f) => f.field === 'f0').value;

describe('directplayout', () => {
  let spx;
  before(async () => {
    spx = await startServer({ casparcg: true });
  });
  after(async () => {
    await spx?.stop();
  });

  it('plays the template with its data on the web renderer and CasparCG', async () => {
    const web = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const ccg = spx.casparcg.next((l) => l.startsWith('CG 1-20 ADD'));
    const res = await direct(spx, play());

    assert.equal(res.status, 200);
    assert.equal(res.json.relativeTemplatePath, TEMPLATE);
    const msg = await web;
    assert.equal(msg.relpath, TEMPLATE);
    assert.equal(msg.webplayout, '4');
    assert.deepEqual(msg.fields, [{ f0: 'Breaking' }]);
    assert.match(await ccg, /^CG 1-20 ADD 1 "[^"]*\/softpix\/html\/Template_Pack_1\.4\.0\/INFO_LEFT\.html" 1 "\{\\"f0\\":\\"Breaking\\"\}"$/);
  });

  it('accepts the template path without a leading slash', async () => {
    const res = await direct(spx, play({ relativeTemplatePath: TEMPLATE.slice(1) }));
    assert.equal(res.status, 200);
    assert.equal(res.json.relativeTemplatePath, TEMPLATE);
  });

  it('cleans up values like rundown item values', async () => {
    const web = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const res = await direct(spx, play({ DataFields: [{ field: 'f0', value: 'Dana "D" <Scully>' }] }));
    assert.equal(res.status, 200);
    assert.deepEqual((await web).fields, [{ f0: 'Dana &quot;D&quot; &lt;Scully&gt;' }]);
  });

  it('continue and stop reach both targets', async () => {
    const webNext = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'nextTemplate');
    const ccgNext = spx.casparcg.next((l) => l.startsWith('CG 1-20 NEXT'));
    assert.equal((await direct(spx, play({ command: 'continue' }))).status, 200);
    await webNext;
    await ccgNext;

    const webStop = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    const ccgStop = spx.casparcg.next((l) => l.startsWith('CG 1-20 STOP'));
    assert.equal((await direct(spx, play({ command: 'stop' }))).status, 200);
    await webStop;
    await ccgStop;
  });

  it('stops automatically after a numeric out time', async () => {
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 5000);
    const res = await direct(spx, play({ out: '1500', casparServer: '-' }));
    assert.equal(res.status, 200);
    const start = Date.now();
    await stopped;
    assert.ok(Date.now() - start >= 1000, 'stopped before the out time');
  });

  it('does not touch rundown files or the in-memory rundown', async () => {
    const before = readItem(spx, 'MyFirstRundown', ITEM);
    assert.equal((await direct(spx, play())).status, 200);
    assert.deepEqual(readItem(spx, 'MyFirstRundown', ITEM), before);
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).status, 404);
  });

  it("Companion's default body is valid but needs a real template", async () => {
    const res = await companionAction(spx.port, 'directplayout');
    assert.equal(res.status, 404);
    assert.match(res.json.message, /vendor\/pack\/templatefile\.html.*not found/);
  });

  const errors = [
    ['no command', { command: undefined }, 400, /command/],
    ['an unknown command', { command: 'explode' }, 400, /command/],
    ['no template', { relativeTemplatePath: '' }, 400, /relativeTemplatePath/],
    ['a template outside ASSETS/templates', { relativeTemplatePath: '../../config.json' }, 404, /not found/],
    ['a folder as template', { relativeTemplatePath: '/softpix/html' }, 404, /not found/],
    ['DataFields that is not an array', { DataFields: { f0: 'x' } }, 400, /DataFields/],
    ['DataFields without field names', { DataFields: [{ value: 'x' }] }, 400, /DataFields/],
    ['no target', { casparServer: '-', webplayoutLayer: '-' }, 400, /No playout target/],
    ['updateRundownItem without a rundown', { updateRundownItem: { itemID: ITEM, project: 'MyFirstProject' } }, 400, /itemID, project and rundown/],
    ['updateRundownItem with a path as rundown', { updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: '../../x', persist: true } }, 400, /invalid project or rundown/],
    ['updateRundownItem with an unknown rundown', { updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: 'Nope', persist: true } }, 404, /not found/],
    ['persist with an unknown item', { updateRundownItem: { itemID: 'nope', project: 'MyFirstProject', rundown: 'MyFirstRundown', persist: true } }, 404, /not found/],
    ['persist with continue', { command: 'continue', updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: 'MyFirstRundown', persist: true } }, 400, /play and stop/],
  ];
  for (const [name, extra, status, message] of errors) {
    it(`answers ${status} for ${name}`, async () => {
      const res = await direct(spx, play(extra));
      assert.equal(res.status, status);
      assert.equal(res.json.status, status);
      assert.match(res.json.message, message);
    });
  }

  it('rejects the body sent by Companion module v2.0.1 (a JSON string)', async () => {
    const res = await fetch(`${spx.baseUrl}/api/v1/directplayout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('"casparServer": "OVERLAY", "command": "play"'),
    });
    assert.equal(res.status, 400);
  });

  it('is listed without the lock icon on the API docs page', async () => {
    const html = await (await fetch(`${spx.baseUrl}/api/v1`)).text();
    const link = html.search(/\/api\/v1\/directplayout\s*</);
    assert.ok(link > 0);
    assert.ok(!html.slice(html.lastIndexOf('api-card', link), link).includes('🔒'));
  });
});

describe('directplayout saving to a rundown item', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  const persist = (extra = {}, link = {}) =>
    play({
      casparServer: '-',
      DataFields: [{ field: 'f0', value: 'Saved via API' }],
      updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: 'MyFirstRundown', persist: true, ...link },
      ...extra,
    });

  it('saves the data and on-air state to the rundown file', async () => {
    const collecting = spx.listener.collect('SPXMessage2Controller', 500);
    const res = await direct(spx, persist());
    assert.equal(res.status, 200);
    const item = readItem(spx, 'MyFirstRundown', ITEM);
    assert.equal(f0(item), 'Saved via API');
    assert.equal(item.onair, 'true');
    // No controller open: memory stays empty, no reload requested.
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).status, 404);
    assert.deepEqual((await collecting).filter((d) => d.APIcmd === 'RundownReload'), []);
  });

  it('saves raw values and plays them cleaned up once, now and when replayed', async () => {
    const text = `Rock & Roll's "night"`;
    const cleaned = 'Rock &amp; Roll&#039;s &quot;night&quot;';
    const direct1 = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const res = await direct(spx, persist({ DataFields: [{ field: 'f0', value: text }] }));
    assert.equal(res.status, 200);
    assert.deepEqual((await direct1).fields, [{ f0: cleaned }]);
    assert.equal(f0(readItem(spx, 'MyFirstRundown', ITEM)), text);

    // Played later as a normal rundown item.
    const replay = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const again = await fetch(`${spx.baseUrl}/api/v1/controlRundownItemByID?file=MyFirstProject/MyFirstRundown&item=${ITEM}&command=play`);
    assert.equal(again.status, 200);
    assert.equal((await replay).fields.find((f) => 'f0' in f).f0, cleaned);
  });

  it('stop saves the item as off-air', async () => {
    assert.equal((await direct(spx, persist({ command: 'stop' }))).status, 200);
    assert.equal(readItem(spx, 'MyFirstRundown', ITEM).onair, 'false');
  });

  it('asks controllers showing the rundown to reload when updateUI is set', async () => {
    const reload = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === 'RundownReload');
    const res = await direct(spx, persist({}, { updateUI: true }));
    assert.equal(res.status, 200);
    assert.deepEqual(await reload, { APIcmd: 'RundownReload', project: 'MyFirstProject', rundown: 'MyFirstRundown' });
  });
});

describe('directplayout with an open controller', () => {
  let spx;
  let gc;
  before(async () => {
    spx = await startServer();
    gc = await openController(spx.baseUrl, 'MyFirstProject', 'MyFirstRundown');
  });
  after(async () => {
    await gc?.close();
    await spx?.stop();
  });

  const link = (extra) => ({ itemID: ITEM, project: 'MyFirstProject', rundown: 'MyFirstRundown', ...extra });

  it('updateUI without persist updates the item indicator', async () => {
    const res = await direct(spx, play({ casparServer: '-', updateRundownItem: link({ updateUI: true }) }));
    assert.equal(res.status, 200);
    await gc.waitFor(() => gc.onair(ITEM) === 'true');
    assert.equal(gc.reloads(), 0);
    assert.equal(f0(readItem(spx, 'MyFirstRundown', ITEM)), 'Headquarters', 'data must not be saved');
  });

  it('persist with updateUI saves the data and reloads the controller', async () => {
    const before = gc.reloads();
    const res = await direct(spx, play({
      casparServer: '-',
      DataFields: [{ field: 'f0', value: 'New headline' }],
      updateRundownItem: link({ persist: true, updateUI: true }),
    }));
    assert.equal(res.status, 200);
    await gc.waitFor(() => gc.reloads() > before);

    // Memory (used by the open controller) and file agree.
    assert.equal(f0(readItem(spx, 'MyFirstRundown', ITEM)), 'New headline');
    const memory = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(f0(memory.templates.find((t) => t.itemID === ITEM)), 'New headline');

    // What the controller shows after its reload.
    const reloaded = await openController(spx.baseUrl, 'MyFirstProject', 'MyFirstRundown');
    try {
      const input = reloaded.row(ITEM).querySelector('[data-update="f0"]');
      assert.equal(input.value, 'New headline');
      assert.equal(reloaded.onair(ITEM), 'true');
    } finally {
      await reloaded.close();
    }
  });

  it('persist to another rundown leaves the open one alone', async () => {
    const dataDir = path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'data');
    fs.copyFileSync(path.join(dataDir, 'MyFirstRundown.json'), path.join(dataDir, 'OtherRundown.json'));
    const openBefore = readItem(spx, 'MyFirstRundown', ITEM);
    const reloadsBefore = gc.reloads();

    const res = await direct(spx, play({
      casparServer: '-',
      DataFields: [{ field: 'f0', value: 'Other rundown text' }],
      updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: 'OtherRundown', persist: true, updateUI: true },
    }));
    assert.equal(res.status, 200);
    assert.equal(f0(readItem(spx, 'OtherRundown', ITEM)), 'Other rundown text');
    assert.deepEqual(readItem(spx, 'MyFirstRundown', ITEM), openBefore);

    const memory = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(memory.rundown, 'MyFirstRundown');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(gc.reloads(), reloadsBefore, 'the controller shows another rundown and must not reload');
  });
});
