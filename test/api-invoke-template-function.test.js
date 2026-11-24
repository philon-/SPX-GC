// /api/v1/invokeTemplateFunction calls a function in a template on air, on
// the web renderer and/or CasparCG. Companion action "invokeTemplateFunction"
// (patched module request shape, see test/helpers/companion.js).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/spx-server');
const { companionAction } = require('./helpers/companion');

// How CasparCG reads a quoted AMCP parameter.
const amcpUnquote = (s) => s.replace(/\\(["\\])/g, '$1');

describe('invokeTemplateFunction with web renderer and CasparCG', () => {
  let spx;
  before(async () => {
    spx = await startServer({ casparcg: true });
  });
  after(async () => {
    await spx?.stop();
  });

  it('Companion default action calls the function on both targets', async () => {
    const web = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'invokeFunction');
    const ccg = spx.casparcg.next((l) => l.startsWith('CG 1-19 INVOKE'));
    const res = await companionAction(spx.port, 'invokeTemplateFunction');

    assert.equal(res.status, 200);
    assert.equal(res.json.message, 'OK');
    assert.deepEqual(res.json.warnings, ['Web renderer layer 19 is above 5: the renderer uses layer 5.']);
    const msg = await web;
    assert.equal(msg.function, 'myCustomTemplateFunction');
    assert.equal(msg.params, 'Hello World');
    assert.equal(msg.webplayout, '19');
    assert.equal(await ccg, 'CG 1-19 INVOKE 1 "myCustomTemplateFunction(\\"Hello World\\")"');
  });

  it('passes JSON params unchanged to both targets', async () => {
    const params = JSON.stringify({ name: 'Dana "D" Scully', path: 'C:\\temp', n: 1, text: 'a & b?' });
    const web = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'invokeFunction');
    const ccg = spx.casparcg.next((l) => l.startsWith('CG 1-20 INVOKE'));
    const res = await companionAction(spx.port, 'invokeTemplateFunction', {
      playlayer: '20',
      webplayout: '2',
      customFunction: 'update',
      params,
    });
    assert.equal(res.status, 200);
    assert.equal((await web).params, params);
    const quoted = (await ccg).match(/^CG 1-20 INVOKE 1 "(.*)"$/)[1];
    assert.equal(amcpUnquote(quoted), `update(${JSON.stringify(params)})`);
  });

  it('invokes on CasparCG only when no web layer is given', async () => {
    const ccg = spx.casparcg.next((l) => l.startsWith('CG 2-5 INVOKE'));
    const collecting = spx.listener.collect('SPXMessage2Client');
    const res = await companionAction(spx.port, 'invokeTemplateFunction', {
      playchannel: '2',
      playlayer: '5',
      webplayout: '-',
    });
    assert.equal(res.status, 200);
    await ccg;
    assert.deepEqual((await collecting).filter((d) => d.spxcmd === 'invokeFunction'), []);
  });

  it('matches the CasparCG server name case-insensitively', async () => {
    const ccg = spx.casparcg.next((l) => l.startsWith('CG 1-7 INVOKE'));
    const res = await companionAction(spx.port, 'invokeTemplateFunction', { playserver: 'overlay', playlayer: '7', webplayout: '-' });
    assert.equal(res.status, 200);
    assert.equal(res.json.playserver, 'OVERLAY');
    await ccg;
  });

  const errors = [
    ['code instead of a function name', { customFunction: 'alert(1);x' }, /function name/],
    ['a property path', { customFunction: 'window.close' }, /function name/],
    ['an empty function name', { customFunction: '' }, /function name/],
    ['a non-numeric web layer', { webplayout: 'top' }, /Web renderer layer/],
    ['a non-numeric CasparCG layer', { playlayer: 'x' }, /channel and layer/],
    ['no target', { playserver: '-', webplayout: '-' }, /No playout target/],
  ];
  for (const [name, opts, message] of errors) {
    it(`answers 400 for ${name}`, async () => {
      const collecting = spx.listener.collect('SPXMessage2Client');
      const res = await companionAction(spx.port, 'invokeTemplateFunction', opts);
      assert.equal(res.status, 400);
      assert.match(res.json.message, message);
      assert.deepEqual((await collecting).filter((d) => d.spxcmd === 'invokeFunction'), []);
    });
  }

  it('is listed without the lock icon on the API docs page', async () => {
    const html = await (await fetch(`${spx.baseUrl}/api/v1`)).text();
    const link = html.indexOf('/api/v1/invokeTemplateFunction?');
    assert.ok(link > 0);
    assert.ok(!html.slice(html.lastIndexOf('api-card', link), link).includes('🔒'));
  });
});

describe('invokeTemplateFunction without CasparCG configured', () => {
  it('skips the CasparCG server with a warning and invokes on the web renderer', async () => {
    const spx = await startServer();
    try {
      const web = spx.listener.next('SPXMessage2Client', (d) => d.spxcmd === 'invokeFunction');
      const res = await companionAction(spx.port, 'invokeTemplateFunction', { webplayout: '3' });
      assert.equal(res.status, 200);
      assert.equal(res.json.playserver, '-');
      assert.deepEqual(res.json.warnings, ['CasparCG server [OVERLAY] is not configured in SPX, skipped.']);
      assert.equal((await web).webplayout, '3');
    } finally {
      await spx.stop();
    }
  });
});
