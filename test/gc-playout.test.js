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

  it('keeps the project and rundown name of the in-memory rundown', async () => {
    // Regression: on macOS/Linux the project became undefined after a
    // playout, because the rundown path was only split on backslashes.
    const rundown = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(rundown.project, 'MyFirstProject');
    assert.equal(rundown.rundown, 'MyFirstRundown');
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

// Prepopulated playouts carry all template data in the request, without a
// rundown item behind them (used e.g. by extension buttons).
describe('POST /gc/playout with prepopulated data', () => {
  let spx;
  before(async () => {
    spx = await startServer();
    assert.equal((await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  it('plays the template and leaves the open rundown in memory', async () => {
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    const res = await fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prepopulated: 'true',
        command: 'play',
        relpath: '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html',
        playserver: '-',
        playchannel: '1',
        playlayer: '10',
        webplayout: '10',
        dataformat: 'json',
        fields: [{ field: 'f0', value: 'From an extension' }],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await msg).fields, [{ f0: 'From an extension' }]);

    // Regression: the in-memory rundown was replaced with an empty string.
    const open = await fetch(`${spx.baseUrl}/api/v1/rundown/get`);
    assert.equal(open.status, 200);
    assert.equal((await open.json()).rundown, 'MyFirstRundown');
  });

  it('continues the template', async () => {
    // Regression: crashed with 500 marking a (non-existent) rundown item on air.
    const msg = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'nextTemplate');
    const res = await fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prepopulated: 'true',
        command: 'next',
        relpath: '/softpix/html/Template_Pack_1.4.0/INFO_LEFT.html',
        playserver: '-',
        playchannel: '1',
        playlayer: '10',
        webplayout: '10',
      }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal((await msg).webplayout, '10');
  });
});

describe('POST /gc/playout invoke on CasparCG', () => {
  let spx;
  before(async () => {
    spx = await startServer({ casparcg: true });
  });
  after(async () => {
    await spx?.stop();
  });

  // How CasparCG reads a quoted AMCP parameter.
  const amcpUnquote = (s) => s.replace(/\\(["\\])/g, '$1');

  it('escapes quotes and backslashes in the function call', async () => {
    const invoke = 'myFunc("{\\"name\\":\\"Dana \\\\\\"D\\\\\\" Scully\\"}")';
    const cmd = spx.casparcg.next((l) => l.startsWith('CG 1-10 INVOKE'));
    const res = await fetch(`${spx.baseUrl}/gc/playout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prepopulated: 'true', command: 'invoke', playserver: 'OVERLAY', playchannel: '1', playlayer: '10', webplayout: '-', invoke }),
    });
    assert.equal(res.status, 200);
    const line = await cmd;
    const quoted = line.match(/^CG 1-10 INVOKE 1 "(.*)"$/)[1];
    assert.equal(amcpUnquote(quoted), invoke);
  });
});
