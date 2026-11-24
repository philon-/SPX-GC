// Companion actions against a real, open controller page (jsdom): the API
// call must make the controller play/stop the right item, which then reaches
// the renderer and is saved to the rundown.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/spx-server');
const { openController } = require('./helpers/controller');
const { companionAction } = require('./helpers/companion');

const MANUAL_ITEM = '1773083297691'; // INFO_LEFT, webplayout 4
const OTHER_ITEM = '1773083297693'; // NAME_LEFT, webplayout 3

describe('Companion actions with an open controller', () => {
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

  const template = (itemID) => {
    try {
      return spx.readRundown('MyFirstProject', 'MyFirstRundown').templates.find((t) => t.itemID === itemID);
    } catch (e) {
      return undefined; // file being written, retry
    }
  };
  const fileOnair = (itemID) => template(itemID)?.onair;

  it('play_ID plays the item on the renderer and marks it on air', async () => {
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    assert.equal((await companionAction(spx.port, 'play_ID', { id: MANUAL_ITEM })).status, 200);
    assert.equal((await render).relpath, '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html');
    await gc.waitFor(() => gc.onair(MANUAL_ITEM) === 'true');
    await gc.waitFor(() => fileOnair(MANUAL_ITEM) === 'true');
  });

  it('stop_ID stops it again', async () => {
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    assert.equal((await companionAction(spx.port, 'stop_ID', { id: MANUAL_ITEM })).status, 200);
    assert.equal((await render).webplayout, '4');
    await gc.waitFor(() => gc.onair(MANUAL_ITEM) === 'false');
    await gc.waitFor(() => fileOnair(MANUAL_ITEM) === 'false');
  });

  it('focusFirst + play plays the first row', async () => {
    const firstID = gc.window.document.querySelector('.itemrow').getAttribute('data-spx-epoch');
    const expected = template(firstID).relpath; // read before anything is written
    assert.equal((await companionAction(spx.port, 'focusFirst')).status, 200);
    const render = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    assert.equal((await companionAction(spx.port, 'play')).status, 200);
    assert.equal((await render).relpath, expected);
    await gc.waitFor(() => gc.onair(firstID) === 'true');
  });

  it('controlRundownItem plays once and updates the indicator', async () => {
    const collecting = spx.listener.collect('SPXMessage2Client', 1000);
    const res = await companionAction(spx.port, 'controlRundownItem', {
      file: 'MyFirstProject/MyFirstRundown',
      id: OTHER_ITEM,
      command: 'play',
    });
    assert.equal(res.status, 200);
    await gc.waitFor(() => gc.onair(OTHER_ITEM) === 'true');
    const plays = (await collecting).filter((d) => d.spxcmd === 'playTemplate');
    assert.equal(plays.length, 1, 'the controller must not play the item a second time');
  });

  it('is recognised as open, so controlRundownItem plays from its state', async () => {
    // Regression: the page could connect before registering its identify
    // handler, and then never told the server it is a controller.
    const untouched = '1773083297694'; // NAME_RIGHT, not used by other tests
    const res = await companionAction(spx.port, 'controlRundownItem', {
      file: 'MyFirstProject/MyFirstRundown',
      id: untouched,
      command: 'play',
    });
    assert.equal(res.status, 200);
    const memory = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(memory.templates.find((t) => t.itemID === untouched).onair, 'true');
  });

  it('openRundown makes the controller navigate to the rundown', async () => {
    const before = gc.reloads();
    const res = await companionAction(spx.port, 'openRundown', { rundown: 'MyFirstProject/MySecondRundown' });
    assert.equal(res.status, 200);
    await gc.waitFor(() => gc.reloads() > before);
  });
});
