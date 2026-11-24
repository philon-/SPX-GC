// /api/v1/controlRundownItemByID?file=Project/Rundown&item=ID&command=play|continue|stop
// Used by the Companion action "controlRundownItem". Runs the item on the
// server, so it works without the rundown being open in a controller.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');
const { companionAction } = require('./helpers/companion');

const FILE = 'MyFirstProject/MyFirstRundown';
const MANUAL_ITEM = '1773083297691'; // INFO_LEFT, out: manual, webplayout 4
const AUTO_OUT_ITEM = '1773083297692'; // INFO_RIGHT, out: 3000 ms, webplayout 5
const STEPS_ITEM = '1773083297697'; // TITLE_2_STEPS, webplayout 2

const control = (spx, command, id = MANUAL_ITEM, file = FILE) =>
  companionAction(spx.port, 'controlRundownItem', { file, id, command });

const rundownFile = (spx, rundown) => path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'data', `${rundown}.json`);

const onair = (spx, itemID, rundown = 'MyFirstRundown') =>
  spx.readRundown('MyFirstProject', rundown).templates.find((t) => t.itemID === itemID).onair;

describe('controlRundownItemByID without an open controller', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('play sends the item to the renderer and saves it as on-air', async () => {
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const res = await control(spx, 'play');

    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { status: 200, message: 'OK', file: FILE, item: MANUAL_ITEM, command: 'play' });
    const out = await render;
    assert.equal(out.relpath, '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html');
    assert.equal(out.webplayout, '4');
    assert.deepEqual(out.fields.find((f) => 'f0' in f), { f0: 'Headquarters' });
    assert.equal(onair(spx, MANUAL_ITEM), 'true');
  });

  it('sends no controller UI update when the rundown is not open', async () => {
    const res = await control(spx, 'play', '1773083297693');
    assert.equal(res.status, 200);
    const ui = (await spx.listener.collect('SPXMessage2Client')).filter((d) => d.spxcmd === 'updateRundownItem');
    assert.deepEqual(ui, []);
  });

  it('does not load the rundown into memory', async () => {
    const res = await fetch(`${spx.baseUrl}/api/v1/rundown/get`);
    assert.equal(res.status, 404);
  });

  it('continue sends nextTemplate and no UI toggle', async () => {
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'nextTemplate');
    const res = await control(spx, 'continue', STEPS_ITEM);
    assert.equal(res.status, 200);
    assert.equal((await render).webplayout, '2');
    const ui = (await spx.listener.collect('SPXMessage2Client')).filter((d) => d.spxcmd === 'updateRundownItem');
    assert.deepEqual(ui, []);
  });

  it('stop stops the item on the renderer and saves it as off-air', async () => {
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    const res = await control(spx, 'stop');
    assert.equal(res.status, 200);
    assert.equal((await render).webplayout, '4');
    assert.equal(onair(spx, MANUAL_ITEM), 'false');
  });

  it('stops items with a numeric out time automatically', async () => {
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 6000);
    const res = await control(spx, 'play', AUTO_OUT_ITEM);
    assert.equal(res.status, 200);
    const started = Date.now();
    assert.equal((await stopped).webplayout, '5');
    assert.ok(Date.now() - started >= 2500, 'stopped before the 3000 ms out time');
  });

  const errors = [
    ['unknown rundown', { file: 'MyFirstProject/NoSuchRundown' }, 404, /not found/],
    ['unknown item', { id: 'no-such-item' }, 404, /not found/],
    ['missing item', { id: '' }, 400, /item/],
    ['unknown command', { command: 'explode' }, 400, /play, continue or stop/],
    ['file without rundown', { file: 'MyFirstProject' }, 400, /Project\/Rundown/],
    ['path traversal', { file: '../MyFirstProject' }, 400, /outside the dataroot/],
    ['nested path', { file: 'MyFirstProject/../../x' }, 400, /Project\/Rundown/],
    ['project name starting with dots', { file: '..x/MyFirstRundown' }, 404, /not found/],
  ];
  for (const [name, opts, status, message] of errors) {
    it(`answers ${status} for ${name}`, async () => {
      const res = await companionAction(spx.port, 'controlRundownItem', {
        file: FILE,
        id: MANUAL_ITEM,
        command: 'play',
        ...opts,
      });
      assert.equal(res.status, status);
      assert.equal(res.json.status, status);
      assert.match(res.json.message, message);
    });
  }
});

describe('controlRundownItemByID with malformed query strings', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  // Regression: repeated parameters (arrays) made the handler throw, and
  // the request never got a response.
  for (const [name, query] of [
    ['item', `file=${FILE}&item=a&item=b&command=play`],
    ['command', `file=${FILE}&item=${MANUAL_ITEM}&command=play&command=stop`],
    ['file', `file=${FILE}&file=${FILE}&item=${MANUAL_ITEM}&command=play`],
  ]) {
    it(`answers a repeated ${name} parameter with an error`, async () => {
      const res = await fetch(`${spx.baseUrl}/api/v1/controlRundownItemByID?${query}`, { signal: AbortSignal.timeout(5000) });
      assert.ok(res.status === 400 || res.status === 404, `status ${res.status}`);
    });
  }
});

describe('controlRundownItemByID with the rundown open in a controller', () => {
  let spx;
  before(async () => {
    spx = await startServer();
    await spx.listener.identify('SPX_CONTROLLER');
    assert.equal((await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  const memoryItem = async (itemID) => {
    const rundown = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    return rundown.templates.find((t) => t.itemID === itemID);
  };

  it('plays from the controller state and keeps memory and file in sync', async () => {
    const ui = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'updateRundownItem');
    const res = await control(spx, 'play');
    assert.equal(res.status, 200);
    assert.deepEqual(await ui, {
      spxcmd: 'updateRundownItem',
      itemID: MANUAL_ITEM,
      relpath: '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html',
      command: 'play',
    });
    assert.equal((await memoryItem(MANUAL_ITEM)).onair, 'true');
    assert.equal(onair(spx, MANUAL_ITEM), 'true');

    // A later play from the controller (which uses memory) must not
    // overwrite the API's on-air state in the file.
    await fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datafile: rundownFile(spx, 'MyFirstRundown'), epoch: '1773083297693', command: 'play' }),
    });
    assert.equal(onair(spx, MANUAL_ITEM), 'true');
  });

  it('stops auto-out items itself too, in case the controller does not', async () => {
    // The controller runs the same timer, and whichever stops the item first
    // cancels the other. This stand-in controller never stops anything, like
    // a controller tab that was closed after the play.
    const uiPlay = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'updateRundownItem' && d.command === 'play');
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 6000);
    const uiStop = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'updateRundownItem' && d.command === 'stop', 6000);
    const res = await control(spx, 'play', AUTO_OUT_ITEM);
    assert.equal(res.status, 200);
    await uiPlay;
    assert.equal((await stopped).webplayout, '5');
    assert.equal((await uiStop).itemID, AUTO_OUT_ITEM);
    assert.equal((await memoryItem(AUTO_OUT_ITEM)).onair, 'false');
    assert.equal(onair(spx, AUTO_OUT_ITEM), 'false');
  });

  it('plays another rundown from its file without touching the open one', async () => {
    // A second rundown with the same items, not open anywhere.
    fs.copyFileSync(rundownFile(spx, 'MyFirstRundown'), rundownFile(spx, 'OtherRundown'));
    const collecting = spx.listener.collect('SPXMessage2Client');
    const res = await control(spx, 'play', '1773083297694', 'MyFirstProject/OtherRundown');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    // The open controller shows MyFirstRundown, which has an item with the
    // same ID: it must not be told to update it.
    const ui = (await collecting).filter((d) => d.spxcmd === 'updateRundownItem');
    assert.deepEqual(ui, []);
    assert.equal(onair(spx, '1773083297694', 'OtherRundown'), 'true');
    assert.notEqual((await memoryItem('1773083297694')).onair, 'true');

    const open = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(open.rundown, 'MyFirstRundown');
  });
});

describe('controlRundownItemByID when the controller tab was closed', () => {
  it('falls back to the file and server-side auto-out', async () => {
    const spx = await startServer();
    try {
      // Opened once (memory now holds it), but no controller is connected.
      assert.equal((await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).status, 200);
      const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 6000);
      const res = await control(spx, 'play', AUTO_OUT_ITEM);
      assert.equal(res.status, 200);
      assert.equal((await stopped).webplayout, '5');
    } finally {
      await spx.stop();
    }
  });
});

describe('controlRundownItemByID with a CasparCG server', () => {
  let spx;
  before(async () => {
    spx = await startServer({ casparcg: true });
  });
  after(async () => {
    await spx?.stop();
  });

  it('play adds the template with its data on the CasparCG layer', async () => {
    const cmd = spx.casparcg.next((l) => l.startsWith('CG 1-4 ADD'));
    const res = await control(spx, 'play');
    assert.equal(res.status, 200);
    const line = await cmd;
    assert.match(line, /^CG 1-4 ADD 1 "[^"]*\/softpix\/html\/Template_Pack_1\.4\.0\/INFO_LEFT\.html" 1 "/);
    assert.match(line, /\\"f0\\":\\"Headquarters\\"/);
  });

  it('continue and stop send NEXT and STOP', async () => {
    const next = spx.casparcg.next((l) => l.startsWith('CG 1-2 NEXT'));
    assert.equal((await control(spx, 'continue', STEPS_ITEM)).status, 200);
    await next;
    const stop = spx.casparcg.next((l) => l.startsWith('CG 1-4 STOP'));
    assert.equal((await control(spx, 'stop')).status, 200);
    await stop;
  });
});
