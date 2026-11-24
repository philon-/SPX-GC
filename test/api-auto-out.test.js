// Server-side auto-out of graphics played through the API (numeric "out"):
// the server stops them like an API stop (state saved, controllers updated),
// a new play or stop of the same item or on the same layers cancels a
// pending auto-out, and it also runs when the rundown is open in a
// controller, in case that controller is closed before the time is up.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');
const { openController } = require('./helpers/controller');

const ITEM = '1773083297691'; // INFO_LEFT on web layer 4 (CasparCG OVERLAY 1-4)
const TEMPLATE = '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html';
const RUNDOWN = 'AutoOut';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rundownFile = (spx, rundown = RUNDOWN) => path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'data', `${rundown}.json`);

// A copy of MyFirstRundown in which ITEM has the given out time.
function writeRundown(spx, out) {
  const data = JSON.parse(fs.readFileSync(rundownFile(spx, 'MyFirstRundown'), 'utf8'));
  data.templates.find((t) => t.itemID === ITEM).out = String(out);
  fs.writeFileSync(rundownFile(spx), JSON.stringify(data, null, 2));
}
const fileOnair = (spx) => {
  try {
    return JSON.parse(fs.readFileSync(rundownFile(spx), 'utf8')).templates.find((t) => t.itemID === ITEM).onair;
  } catch (e) {
    return undefined; // being written
  }
};
const control = (spx, command) =>
  fetch(`${spx.baseUrl}/api/v1/controlRundownItemByID?file=MyFirstProject/${RUNDOWN}&item=${ITEM}&command=${command}`);
const controllerPlayout = (spx, command) =>
  fetch(`${spx.baseUrl}/gc/playout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ datafile: rundownFile(spx), epoch: ITEM, command }),
  });
const direct = (spx, body) =>
  fetch(`${spx.baseUrl}/api/v1/directplayout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webplayoutLayer: '4', relativeTemplatePath: TEMPLATE, command: 'play', ...body }),
  });
const waitFor = async (predicate, timeoutMs = 5000) => {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out');
    await sleep(50);
  }
};

describe('auto-out without a controller', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('stops the item and saves it as off air', async () => {
    writeRundown(spx, 600);
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    assert.equal((await control(spx, 'play')).status, 200);
    assert.equal(fileOnair(spx), 'true');
    assert.equal((await stopped).webplayout, '4');
    await waitFor(() => fileOnair(spx) === 'false');
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).status, 404, 'memory stays empty');
  });

  it('restarts when the item is played again', async () => {
    writeRundown(spx, 1000);
    assert.equal((await control(spx, 'play')).status, 200);
    await sleep(500);
    const replayed = Date.now();
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 3000);
    assert.equal((await control(spx, 'play')).status, 200);
    await stopped;
    assert.ok(Date.now() - replayed >= 900, 'the first play\'s auto-out cut the replay short');
  });

  it('is cancelled by a stop and play from the controller', async () => {
    writeRundown(spx, 800);
    assert.equal((await control(spx, 'play')).status, 200);
    await sleep(200);
    assert.equal((await controllerPlayout(spx, 'stop')).status, 200);
    assert.equal((await controllerPlayout(spx, 'play')).status, 200);
    // The controller runs its own timer for its play; the API's must be gone.
    const stops = (await spx.listener.collect('SPXMessage2Client', 1200)).filter((d) => d.spxcmd === 'stopTemplate');
    assert.deepEqual(stops, []);
    assert.equal(fileOnair(spx), 'true');
  });
});

describe('auto-out with an open controller', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('stops the item and updates the controller and saved state', async () => {
    writeRundown(spx, 700);
    const gc = await openController(spx.baseUrl, 'MyFirstProject', RUNDOWN);
    try {
      assert.equal((await control(spx, 'play')).status, 200);
      await gc.waitFor(() => gc.onair(ITEM) === 'true');
      await gc.waitFor(() => gc.onair(ITEM) === 'false', 3000);
      await waitFor(() => fileOnair(spx) === 'false');
      const memory = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
      assert.equal(memory.templates.find((t) => t.itemID === ITEM).onair, 'false');
    } finally {
      await gc.close();
    }
  });

  it('still stops the item when the controller is closed before the out time', async () => {
    writeRundown(spx, 2000);
    const gc = await openController(spx.baseUrl, 'MyFirstProject', RUNDOWN);
    assert.equal((await control(spx, 'play')).status, 200);
    await gc.waitFor(() => gc.onair(ITEM) === 'true');
    await gc.close();
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate', 4000);
    assert.equal((await stopped).webplayout, '4');
    await waitFor(() => fileOnair(spx) === 'false');
  });
});

describe('auto-out of direct playouts', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('marks the linked rundown item off air', async () => {
    writeRundown(spx, 'manual');
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    const res = await direct(spx, {
      out: '600',
      updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: RUNDOWN, persist: true },
    });
    assert.equal(res.status, 200);
    assert.equal(fileOnair(spx), 'true');
    assert.equal((await stopped).webplayout, '4');
    await waitFor(() => fileOnair(spx) === 'false');
  });

  it('is cancelled by a new playout on the same layer', async () => {
    assert.equal((await direct(spx, { out: '800' })).status, 200);
    await sleep(300);
    assert.equal((await direct(spx, { out: 'manual' })).status, 200);
    const stops = (await spx.listener.collect('SPXMessage2Client', 1200)).filter((d) => d.spxcmd === 'stopTemplate');
    assert.deepEqual(stops, [], 'the first playout\'s auto-out stopped the second one');
  });

  it('with persist and updateUI: reloads the controller when played, not when stopped', async () => {
    writeRundown(spx, 'manual');
    const gc = await openController(spx.baseUrl, 'MyFirstProject', RUNDOWN);
    try {
      const indicator = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'updateRundownItem' && d.command === 'stop', 3000);
      const res = await direct(spx, {
        out: '700',
        updateRundownItem: { itemID: ITEM, project: 'MyFirstProject', rundown: RUNDOWN, persist: true, updateUI: true },
      });
      assert.equal(res.status, 200);
      assert.equal((await indicator).itemID, ITEM);
      await gc.waitFor(() => gc.reloads() === 1);
      await waitFor(() => fileOnair(spx) === 'false');
      await sleep(1300); // a reload would happen 1 s after the message
      assert.equal(gc.reloads(), 1, 'auto-out must not reload the controller');
    } finally {
      await gc.close();
    }
  });
});
