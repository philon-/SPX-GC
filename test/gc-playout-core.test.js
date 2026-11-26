// Core POST /gc/playout behaviour that the controller relies on (see also
// gc-playout.test.js): what is saved to disk and what stays in memory,
// one item on air per output layer, preview, update, custom actions, and
// the auto-out of /gc/playout API callers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');

const PROJECT = 'MyFirstProject';
const RUNDOWN = 'MyFirstRundown';
const LAYER1_A = '1773083297695'; // web 1, OVERLAY 1-1
const LAYER1_B = '1773083297696'; // web 1, OVERLAY 1-1
const LAYER4 = '1773083297691'; // web 4
const OUT3000 = '1773083297692'; // web 5, out 3000

describe('POST /gc/playout core behaviour', () => {
  let spx;
  let datafile;
  before(async () => {
    spx = await startServer();
    datafile = path.join(spx.dir, 'DATAROOT', PROJECT, 'data', RUNDOWN + '.json');
    assert.equal((await fetch(`${spx.baseUrl}/gc/${PROJECT}/${RUNDOWN}`)).status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  const playout = (body) =>
    fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datafile, ...body }),
    });
  const onairInFile = (id) => spx.readRundown(PROJECT, RUNDOWN).templates.find((t) => t.itemID === id).onair;
  const onairInMemory = async (id) =>
    (await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json()).templates.find((t) => t.itemID === id).onair;

  it('keeps one item on air per output layer', async () => {
    assert.equal((await playout({ epoch: LAYER1_A, command: 'play' })).status, 200);
    assert.equal((await playout({ epoch: LAYER4, command: 'play' })).status, 200);
    assert.equal((await playout({ epoch: LAYER1_B, command: 'play' })).status, 200);
    assert.equal(onairInFile(LAYER1_A), 'false', 'replaced on the same layer');
    assert.equal(onairInFile(LAYER1_B), 'true');
    assert.equal(onairInFile(LAYER4), 'true', 'other layer untouched');
    await playout({ epoch: LAYER1_B, command: 'stop' });
    await playout({ epoch: LAYER4, command: 'stop' });
  });

  it('playonce plays but keeps the on-air state in memory only', async () => {
    const played = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    assert.equal((await playout({ epoch: LAYER4, command: 'playonce' })).status, 200);
    await played;
    assert.equal(await onairInMemory(LAYER4), 'true');
    assert.equal(onairInFile(LAYER4), 'false');
    await playout({ epoch: LAYER4, command: 'stop' });
    assert.equal(onairInFile(LAYER4), 'false');
  });

  it('preview plays on renderer layer 1 in preview mode and saves nothing', async () => {
    const before = spx.readRundown(PROJECT, RUNDOWN);
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate' && d.playmode === 'preview');
    assert.equal((await playout({ epoch: LAYER4, command: 'preview' })).status, 200);
    assert.equal((await msg).webplayout, '1');
    assert.deepEqual(spx.readRundown(PROJECT, RUNDOWN).templates, before.templates);
  });

  it('update sends the new field values to the renderer', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'updateTemplate');
    const fields = [{ field: 'f0', value: 'Updated' }];
    assert.equal((await playout({ epoch: LAYER4, command: 'update', fields })).status, 200);
    assert.deepEqual((await msg).fields, [{ f0: 'Updated' }]);
  });

  it('customAction is passed to the renderer and answered', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'customAction');
    const res = await playout({ command: 'customAction', id: 'myAction', webplayout: '2' });
    assert.equal(res.status, 200);
    assert.equal((await msg).id, 'myAction');
  });

  it('API callers without their own auto-out get one (forceFileReadOnce + numeric out)', async () => {
    const stopped = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate' && d.webplayout === '5', 6000);
    assert.equal((await playout({ epoch: OUT3000, command: 'play', forceFileReadOnce: true })).status, 200);
    await stopped;
  });

  it('that auto-out is cancelled by a stop', async () => {
    assert.equal((await playout({ epoch: OUT3000, command: 'play', forceFileReadOnce: true })).status, 200);
    assert.equal((await playout({ epoch: OUT3000, command: 'stop' })).status, 200);
    const later = await spx.listener.collect('SPXMessage2Client', 3500);
    assert.deepEqual(later.filter((d) => d.spxcmd === 'stopTemplate'), [], 'no auto-out after the stop');
  });
});
