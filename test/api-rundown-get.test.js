// /api/v1/rundown/get returns the rundown currently open in the controller.
// The Companion module's dynamic presets (presets.js) are built from it.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/spx-server');
const { companionConvertRundown } = require('./helpers/companion');

describe('GET /api/v1/rundown/get', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  const openController = async (project, rundown) => {
    const res = await fetch(`${spx.baseUrl}/gc/${project}/${rundown}`);
    assert.equal(res.status, 200);
  };

  it('answers 404 when no rundown has been opened', async () => {
    const res = await fetch(`${spx.baseUrl}/api/v1/rundown/get`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.message, /No rundown/);
    // Companion's preset parser copes with this (no presets).
    assert.deepEqual(companionConvertRundown(body), []);
  });

  it('returns the rundown opened in the controller', async () => {
    await openController('MyFirstProject', 'MyFirstRundown');
    const res = await fetch(`${spx.baseUrl}/api/v1/rundown/get`);
    assert.equal(res.status, 200);
    const rundown = await res.json();

    const file = spx.readRundown('MyFirstProject', 'MyFirstRundown');
    assert.equal(rundown.project, 'MyFirstProject');
    assert.equal(rundown.rundown, 'MyFirstRundown');
    assert.deepEqual(
      rundown.templates.map((t) => t.itemID),
      file.templates.map((t) => t.itemID)
    );
  });

  it('follows the controller when another rundown is opened', async () => {
    await openController('MyFirstProject', 'MySecondRundown');
    const rundown = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(rundown.rundown, 'MySecondRundown');
  });

  it('gives Companion one preset per manually stopped item', async () => {
    await openController('MyFirstProject', 'MyFirstRundown');
    const rundown = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    const presets = companionConvertRundown(rundown);

    const file = spx.readRundown('MyFirstProject', 'MyFirstRundown');
    const manual = file.templates.filter((t) => t.out === 'manual');
    assert.ok(manual.length > 0, 'fixture should contain manual items');
    assert.deepEqual(
      presets.map((p) => p.itemID),
      manual.map((t) => t.itemID)
    );
    assert.equal(presets[0].title, 'Headquarters');
  });
});
