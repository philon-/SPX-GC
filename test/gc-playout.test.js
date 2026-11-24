// Characterization of POST /gc/playout as the controller page uses it
// (static/js/spx_gc.js playItem / nextItem): { datafile, epoch, command }.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');

describe('POST /gc/playout from the controller', () => {
  let spx;
  let datafile;
  const itemID = '1773083297691'; // MyFirstRundown: "Top left with icon", webplayout 4

  before(async () => {
    spx = await startServer();
    datafile = path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'data', 'MyFirstRundown.json');
    // Open the rundown in the controller, which loads it into memory.
    assert.equal((await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  const playout = (command) =>
    fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datafile, epoch: itemID, command }),
    });

  it('play sends the template to the web renderer and saves on-air state', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const res = await playout('play');
    assert.equal(res.status, 200);

    const out = await msg;
    assert.equal(out.relpath, '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html');
    assert.equal(out.webplayout, '4');
    assert.deepEqual(out.fields.find((f) => 'f0' in f), { f0: 'Headquarters' });

    const item = spx.readRundown('MyFirstProject', 'MyFirstRundown').templates.find((t) => t.itemID === itemID);
    assert.equal(item.onair, 'true');
  });

  it('next sends nextTemplate to the web renderer', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'nextTemplate');
    const res = await playout('next');
    assert.equal(res.status, 200);
    assert.equal((await msg).webplayout, '4');
  });

  it('stop sends stopTemplate and saves the item as off-air', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'stopTemplate');
    const res = await playout('stop');
    assert.equal(res.status, 200);
    assert.equal((await msg).webplayout, '4');

    const item = spx.readRundown('MyFirstProject', 'MyFirstRundown').templates.find((t) => t.itemID === itemID);
    assert.equal(item.onair, 'false');
  });

  it('answers 500 for an unknown item', async () => {
    const res = await fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ datafile, epoch: 'nope', command: 'play' }),
    });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /not found/);
  });
});
