// /api/v1/item/{play,continue,stop}/:id, used by the Companion actions
// play_ID, continue_ID and stop_ID. The open controller executes them via
// its ItemPlayID / ItemContinueID / ItemStopID handlers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/spx-server');
const { companionAction } = require('./helpers/companion');

describe('Item commands by ID', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  const cases = [
    ['play_ID', 'ItemPlayID'],
    ['continue_ID', 'ItemContinueID'],
    ['stop_ID', 'ItemStopID'],
  ];

  for (const [action, APIcmd] of cases) {
    it(`Companion ${action} sends ${APIcmd} with the item ID to the controller`, async () => {
      const itemID = '1773083297691';
      const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === APIcmd);
      const res = await companionAction(spx.port, action, { id: itemID });

      assert.equal(res.status, 200);
      assert.equal(res.json.APIcmd, APIcmd);
      assert.equal(res.json.itemID, itemID);
      assert.equal((await msg).itemID, itemID);
    });
  }

  it('passes IDs renamed in the SPX UI through unchanged', async () => {
    const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === 'ItemPlayID');
    const res = await companionAction(spx.port, 'play_ID', { id: 'lower-third_1' });
    assert.equal(res.status, 200);
    assert.equal((await msg).itemID, 'lower-third_1');
  });

  it('is listed without the lock icon on the API docs page', async () => {
    const html = await (await fetch(`${spx.baseUrl}/api/v1`)).text();
    for (const cmd of ['play', 'continue', 'stop']) {
      const link = html.indexOf(`/api/v1/item/${cmd}/1234567890`);
      assert.ok(link > 0, `${cmd} by ID missing from docs`);
      const card = html.slice(html.lastIndexOf('api-card', link), link);
      assert.ok(!card.includes('🔒'), `${cmd} by ID still shown as locked`);
    }
  });
});

describe('Item commands by ID with an API key configured', () => {
  it('requires the key', async () => {
    const spx = await startServer({ general: { apikey: 'secret' } });
    try {
      const denied = await fetch(`${spx.baseUrl}/api/v1/item/play/123`);
      assert.match((await denied.json()).error, /apikey missing/);

      const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === 'ItemPlayID');
      const ok = await fetch(`${spx.baseUrl}/api/v1/item/play/123?apikey=secret`);
      assert.equal(ok.status, 200);
      assert.equal((await msg).itemID, '123');
    } finally {
      await spx.stop();
    }
  });
});
