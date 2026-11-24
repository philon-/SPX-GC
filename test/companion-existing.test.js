// Baseline: Companion actions backed by API endpoints that already exist.
// Each action must reach an open SPX controller as an SPXMessage2Controller
// socket message with the expected APIcmd.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/spx-server');
const { companionAction } = require('./helpers/companion');

describe('Companion actions using existing endpoints', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  const cases = [
    ['play', 'ItemPlay'],
    ['continue', 'ItemContinue'],
    ['stop', 'ItemStop'],
    ['focusFirst', 'RundownFocusFirst'],
    ['focusNext', 'RundownFocusNext'],
    ['focusPrevious', 'RundownFocusPrevious'],
    ['focusLast', 'RundownFocusLast'],
    ['stopAllLayers', 'RundownStopAll'],
  ];

  for (const [action, APIcmd] of cases) {
    it(`${action} sends ${APIcmd} to the controller`, async () => {
      const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === APIcmd);
      const res = await companionAction(spx.port, action);
      assert.equal(res.status, 200);
      assert.equal((await msg).APIcmd, APIcmd);
    });
  }

  it('openRundown sends RundownLoad with the file', async () => {
    const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === 'RundownLoad');
    const res = await companionAction(spx.port, 'openRundown', { rundown: 'MyFirstProject/MyFirstRundown' });
    assert.equal(res.status, 200);
    assert.equal((await msg).file, 'MyFirstProject/MyFirstRundown');
  });

  it('openRundown answers 404 for a rundown that does not exist', async () => {
    const res = await companionAction(spx.port, 'openRundown', { rundown: 'MyFirstProject/NoSuchRundown' });
    assert.equal(res.status, 404);
  });
});

// Documents current authentication behaviour. The Companion module cannot
// send an API key, so it only works when SPX runs without login (the
// "no login" choice of the first-run auth policy prompt clears username).
describe('API authentication as seen by Companion', () => {
  it('rejects API calls when a username is set but no apikey is configured', async () => {
    const spx = await startServer({ general: { username: 'admin', password: 'x' } });
    try {
      const res = await companionAction(spx.port, 'play');
      assert.match(res.json?.error || '', /apikey is required/);
      const received = await spx.listener.collect('SPXMessage2Controller');
      assert.deepEqual(received, []);
    } finally {
      await spx.stop();
    }
  });

  it('rejects API calls without the key when an apikey is configured', async () => {
    const spx = await startServer({ general: { apikey: 'secret' } });
    try {
      const res = await companionAction(spx.port, 'play');
      assert.match(res.json?.error || '', /apikey missing/);
    } finally {
      await spx.stop();
    }
  });
});
