// With more than one rundown in use, each rundown's state stays its own.
//
// Before the rundown store, the server kept one in-memory rundown (the last
// one opened) and playout used it for whichever file it was asked about,
// then wrote it to that file. Duplicated rundowns share item IDs, so playing
// in one rundown silently overwrote it with the other one's data.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');

const PROJECT = 'MyFirstProject';
const ITEM = '1773083297691'; // in MyFirstRundown, field f0 = "Headquarters"

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('Two rundowns with shared item IDs', () => {
  let spx;
  let fileA;
  let fileB;

  before(async () => {
    spx = await startServer();
    const data = path.join(spx.dir, 'DATAROOT', PROJECT, 'data');
    fileA = path.join(data, 'MyFirstRundown.json');
    fileB = path.join(data, 'MyFirstRundown copy.json');
    // B is a duplicate of A (same item IDs), then edited.
    assert.equal((await post(`${spx.baseUrl}/gc/duplicateRundown`, { foldname: PROJECT, filename: 'MyFirstRundown.json' })).status, 200);
    const saved = await post(`${spx.baseUrl}/gc/saveItemChanges`, {
      rundownfile: fileB,
      epoch: ITEM,
      DataFields: [{ field: 'f0', value: 'Only in B' }],
    });
    assert.equal(saved.status, 200);
  });
  after(async () => {
    await spx?.stop();
  });

  const f0 = (rundown) => rundown.templates.find((t) => t.itemID === ITEM).DataFields.find((f) => f.field === 'f0').value;
  const onair = (rundown) => rundown.templates.find((t) => t.itemID === ITEM).onair;

  it('playing in A (while B was opened last) plays and saves A, and leaves B alone', async () => {
    // Controller 1 opens A, controller 2 then opens B.
    assert.equal((await fetch(`${spx.baseUrl}/gc/${PROJECT}/MyFirstRundown`)).status, 200);
    assert.equal((await fetch(`${spx.baseUrl}/gc/${PROJECT}/${encodeURIComponent('MyFirstRundown copy')}`)).status, 200);

    // Controller 1 plays the item in A.
    const played = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'playTemplate');
    assert.equal((await post(`${spx.baseUrl}/gc/playout`, { datafile: fileA, epoch: ITEM, command: 'play' })).status, 200);
    assert.deepEqual((await played).fields.find((f) => 'f0' in f), { f0: 'Headquarters' }, "A's data went on air");

    const a = spx.readRundown(PROJECT, 'MyFirstRundown');
    const b = spx.readRundown(PROJECT, 'MyFirstRundown copy');
    assert.equal(f0(a), 'Headquarters', "A's file still has A's data");
    assert.equal(a.rundown, 'MyFirstRundown');
    assert.equal(onair(a), 'true');
    assert.equal(f0(b), 'Only in B');
    assert.equal(onair(b), 'false', 'B was not marked on air');

    // The controller's current rundown is still B.
    const current = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(current.rundown, 'MyFirstRundown copy');
    assert.equal(onair(current), 'false');
  });

  it('an API play of an item in A does not change the open rundown B in memory', async () => {
    await spx.listener.identify('SPX_CONTROLLER'); // a controller is connected (showing B)
    await post(`${spx.baseUrl}/gc/playout`, { datafile: fileB, epoch: ITEM, command: 'playonce' }); // memory-only state in B
    const res = await fetch(`${spx.baseUrl}/api/v1/controlRundownItemByID?file=${PROJECT}/MyFirstRundown&item=${ITEM}&command=stop`);
    assert.equal(res.status, 200);

    const current = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.equal(current.rundown, 'MyFirstRundown copy');
    assert.equal(onair(current), 'true', "B's in-memory on-air state survived the API call");
    assert.equal(onair(spx.readRundown(PROJECT, 'MyFirstRundown')), 'false');
  });

  it('duplicating an item adds it to that rundown only', async () => {
    const res = await post(`${spx.baseUrl}/gc/${PROJECT}/MyFirstRundown`, {
      command: 'duplicateRundownItem',
      datafile: fileA,
      sourceEpoch: ITEM,
      cloneEpoch: '999',
      listname: 'MyFirstRundown',
    });
    assert.equal(res.status, 200);
    const a = spx.readRundown(PROJECT, 'MyFirstRundown');
    const ids = a.templates.map((t) => t.itemID);
    assert.equal(ids[ids.indexOf(ITEM) + 1], '999', 'copy is right after the source');
    const current = await (await fetch(`${spx.baseUrl}/api/v1/rundown/get`)).json();
    assert.ok(!current.templates.some((t) => t.itemID === '999'), 'not added to the open rundown B');
  });
});

describe('Concurrent changes to one rundown', () => {
  it('are applied one after another (none lost, file stays valid)', async () => {
    const spx = await startServer();
    try {
      const file = path.join(spx.dir, 'DATAROOT', PROJECT, 'data', 'MyFirstRundown.json');
      assert.equal((await fetch(`${spx.baseUrl}/gc/${PROJECT}/MyFirstRundown`)).status, 200);
      const ids = spx.readRundown(PROJECT, 'MyFirstRundown').templates.map((t) => t.itemID);
      const results = await Promise.all(
        ids.map((id, i) =>
          post(`${spx.baseUrl}/gc/saveItemChanges`, {
            rundownfile: file,
            epoch: id,
            DataFields: [{ field: 'f0', value: 'edit ' + i }],
          })
        )
      );
      assert.ok(results.every((r) => r.status === 200));
      const saved = spx.readRundown(PROJECT, 'MyFirstRundown');
      ids.forEach((id, i) => {
        const field = saved.templates.find((t) => t.itemID === id).DataFields.find((f) => f.field === 'f0');
        if (field) assert.equal(field.value, 'edit ' + i);
      });
    } finally {
      await spx.stop();
    }
  });
});
