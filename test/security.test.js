// Security fixes: no code execution through request data, no paths outside
// the allowed folders, cross-site browser requests refused, login and API
// key checks, and the socket relay to renderers.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer } = require('./helpers/spx-server');

const EVIL = 'http://evil.example';

// Password hash formats stored in config.json (see spx.hash / spx.legacyHash).
function scryptHash(password) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(password, salt, 32).toString('hex');
}
function legacyHash(password) {
  const key = crypto.scryptSync('Password used to generate key', 'salt', 24);
  const cipher = crypto.createCipheriv('aes-192-cbc', key, Buffer.alloc(16, 0));
  return cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
}

const readConfig = (spx) => JSON.parse(fs.readFileSync(path.join(spx.dir, 'config.json'), 'utf8'));
const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Logs in through the login form; returns the session cookie.
async function login(spx, username, password) {
  const res = await fetch(`${spx.baseUrl}/`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie };
}

function openSocket(baseUrl, headers = {}) {
  const socket = io(baseUrl, { transports: ['websocket'], reconnection: false, extraHeaders: headers });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

describe('No code execution through request data', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('/api/logger does not evaluate the log level', async () => {
    const marker = path.join(spx.dir, 'marker');
    const level = `info(msg);require('child_process').exec('touch ${marker}');//`;
    for (const res of [
      await fetch(`${spx.baseUrl}/api/logger/?message=x&level=${encodeURIComponent(level)}`),
      await post(`${spx.baseUrl}/api/logger/`, { message: 'x', level }),
    ]) {
      assert.equal(res.status, 400);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(marker), false);
  });

  it('/api/logger still logs with a valid level', async () => {
    const res = await fetch(`${spx.baseUrl}/api/logger/?message=hello&source=test&channel=1&level=INFO`);
    assert.equal(res.status, 200);
  });

  it('/CCG/control does not evaluate the element name', async () => {
    const marker = path.join(spx.dir, 'marker-ccg');
    fs.mkdirSync(path.join(spx.dir, 'DATAROOT', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(spx.dir, 'DATAROOT', 'config', 'profiles.json'),
      JSON.stringify({ profiles: [{ name: 'News', templates: {} }] })
    );
    const data = { command: 'STOP', profile: 'News', element: `x;require('child_process').exec('touch ${marker}');//` };
    await fetch(`${spx.baseUrl}/CCG/control/${encodeURIComponent(JSON.stringify(data))}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('Paths from requests stay inside their folders', () => {
  let spx;
  before(async () => {
    spx = await startServer();
  });
  after(async () => {
    await spx?.stop();
  });

  it('savefile refuses names outside the dataroot', async () => {
    const name = 'escaped-' + crypto.randomBytes(4).toString('hex');
    const res = await post(`${spx.baseUrl}/api/savefile/..%2F..%2F${name}`, { a: 1 });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(path.join(spx.dir, '..', name + '.json')), false);
  });

  it('saverundownfile refuses project or rundown names with paths', async () => {
    const res = await post(`${spx.baseUrl}/api/saverundownfile/..%2F..%2F/x`, { templates: [] });
    assert.equal(res.status, 400);
  });

  it('readExcelData refuses files outside ASSETS', async () => {
    const res = await post(`${spx.baseUrl}/api/readExcelData`, { filename: '../config.json' });
    assert.equal(res.status, 403);
  });

  it('browseFiles refuses a root folder outside ASSETS, and stops at the root', async () => {
    const outside = await post(`${spx.baseUrl}/api/browseFiles`, { curFolder: '/', tgtFolder: '', rootFolder: '/' });
    assert.equal(outside.status, 403);

    const assets = path.join(spx.dir, 'ASSETS');
    const up = await post(`${spx.baseUrl}/api/browseFiles`, { curFolder: assets, tgtFolder: '..', rootFolder: assets });
    assert.equal(up.status, 200);
    const body = await up.json();
    assert.equal(body.message, 'root');
    assert.equal(path.resolve(body.folder), path.resolve(assets));
  });

  it('openFileFolder refuses folders outside ASSETS', async () => {
    const res = await fetch(`${spx.baseUrl}/api/openFileFolder?openFolderOnly=..%2F..`);
    assert.equal(res.status, 404);
  });

  it('changeItemData refuses files outside the dataroot', async () => {
    const before = fs.readFileSync(path.join(spx.dir, 'config.json'), 'utf8');
    const file = encodeURIComponent(path.join(spx.dir, 'config.json'));
    const res = await fetch(`${spx.baseUrl}/api/v1/changeItemData?rundownfile=${file}&ID=1&key=out&newValue=x`);
    assert.equal(res.status, 409);
    assert.equal(fs.readFileSync(path.join(spx.dir, 'config.json'), 'utf8'), before);
  });

  it('project and rundown names in URLs and bodies must be plain names', async () => {
    const victim = fs.mkdtempSync(path.join(spx.dir, 'victim-'));
    const name = encodeURIComponent('../' + path.basename(victim));
    const del = await fetch(`${spx.baseUrl}/shows/${name}`, { method: 'DELETE' });
    assert.equal(del.status, 400);
    assert.equal(fs.existsSync(victim), true);

    const sort = await post(`${spx.baseUrl}/gc/sortTemplates`, {
      rundownfile: path.join(spx.dir, 'config.json'),
      newTemplateOrderArr: [],
    });
    assert.equal(sort.status, 400);
  });
});

describe('Cross-site browser requests', () => {
  let spx;
  before(async () => {
    spx = await startServer({ general: { allowedOrigins: ['http://panel.example'] } });
  });
  after(async () => {
    await spx?.stop();
  });

  it('refuses API and UI calls made by pages on other sites', async () => {
    const byOrigin = await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { Origin: EVIL } });
    assert.equal(byOrigin.status, 403);
    const bySecFetch = await fetch(`${spx.baseUrl}/CCG/system/${encodeURIComponent('{"command":"RESTARTSERVER"}')}`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(bySecFetch.status, 403);
    const form = await post(`${spx.baseUrl}/saveauthpolicy`, { policy: '0' }, { Origin: 'null' });
    assert.equal(form.status, 403);
  });

  it('allows same-origin calls, non-browser clients and configured origins', async () => {
    const same = await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { Origin: spx.baseUrl } });
    assert.equal(same.status, 200);
    const plain = await fetch(`${spx.baseUrl}/api/v1/item/play`);
    assert.equal(plain.status, 200);
    const panel = await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { Origin: 'http://panel.example' } });
    assert.equal(panel.status, 200);
    assert.equal(panel.headers.get('access-control-allow-origin'), 'http://panel.example');
  });

  it('keeps template endpoints, pages and static files open to any origin', async () => {
    const logger = await fetch(`${spx.baseUrl}/api/logger/?message=x&level=info`, { headers: { Origin: EVIL } });
    assert.equal(logger.status, 200);
    assert.equal(logger.headers.get('access-control-allow-origin'), '*');
    const renderer = await fetch(`${spx.baseUrl}/renderer`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(renderer.status, 200);
  });

  it('sends no CORS header to other origins', async () => {
    const res = await fetch(`${spx.baseUrl}/api/v1/version`, { headers: { Origin: EVIL } });
    assert.equal(res.status, 200); // template endpoint: readable
    const ui = await fetch(`${spx.baseUrl}/config`, { headers: { Origin: EVIL } });
    assert.equal(ui.headers.get('access-control-allow-origin'), null);
  });
});

describe('Cross-site requests with a valid API key', () => {
  it('are allowed (the key proves the caller is authorized)', async () => {
    const spx = await startServer({ general: { apikey: 'secret' } });
    try {
      const res = await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { Origin: EVIL, 'X-API-Key': 'secret' } });
      assert.equal(res.status, 200);
    } finally {
      await spx.stop();
    }
  });
});

describe('Login', () => {
  let spx;
  before(async () => {
    spx = await startServer({ general: { username: 'admin', password: scryptHash('pw'), apikey: 'secret' } });
  });
  after(async () => {
    await spx?.stop();
  });

  it('protects the UI-internal endpoints', async () => {
    assert.equal((await fetch(`${spx.baseUrl}/api/files`)).status, 401);
    assert.equal((await fetch(`${spx.baseUrl}/CCG/system/${encodeURIComponent('{"command":"CHECKCONNECTIONS"}')}`)).status, 401);
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/changeItemID?rundownfile=x&ID=1&newID=2`)).status, 401);
  });

  it('does not let anyone change the auth policy once it is set', async () => {
    const res = await post(`${spx.baseUrl}/saveauthpolicy`, { policy: '0' });
    assert.equal(res.status, 403);
    assert.equal(readConfig(spx).general.username, 'admin');
  });

  it('a logged-in session can use the UI endpoints and the API', async () => {
    const wrong = await login(spx, 'admin', 'nope');
    assert.equal(wrong.res.headers.get('location'), '/login');

    const { cookie } = await login(spx, 'admin', 'pw');
    assert.ok(cookie);
    assert.equal((await fetch(`${spx.baseUrl}/api/files`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { Cookie: cookie } })).status, 200);
  });

  it('the API answers 401 without a valid key', async () => {
    const missing = await fetch(`${spx.baseUrl}/api/v1/item/play`);
    assert.equal(missing.status, 401);
    assert.match((await missing.json()).error, /apikey missing/);
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/item/play?apikey=wrong`)).status, 401);
    assert.equal((await fetch(`${spx.baseUrl}/api/v1/item/play`, { headers: { 'X-API-Key': 'secret' } })).status, 200);
  });

  it('keeps API keys out of the access log', async () => {
    await fetch(`${spx.baseUrl}/api/v1/item/play?apikey=secret`);
    await new Promise((r) => setTimeout(r, 300));
    const log = fs.readFileSync(path.join(spx.dir, 'LOG', 'access.log'), 'utf8');
    assert.match(log, /apikey=REDACTED/);
    assert.doesNotMatch(log, /apikey=secret/);
  });

  it('does not broadcast the API key to socket clients', async () => {
    const msg = spx.listener.next('SPXMessage2Controller', (d) => d.APIcmd === 'RundownFocusNext');
    await fetch(`${spx.baseUrl}/api/v1/rundown/focusNext?apikey=secret`);
    assert.equal((await msg).apikey, undefined);
  });
});

describe('First-run auth policy and legacy passwords', () => {
  it('the first-run page can set the policy once', async () => {
    const spx = await startServer({ general: { username: 'admin', password: '' } });
    try {
      const res = await post(`${spx.baseUrl}/saveauthpolicy`, { policy: '1', username: 'admin', password: 'pw' }, {});
      assert.equal(res.status, 200); // redirected to the home page
      assert.match(readConfig(spx).general.password, /^scrypt\$/);
      const again = await post(`${spx.baseUrl}/saveauthpolicy`, { policy: '0' });
      assert.equal(again.status, 403);
    } finally {
      await spx.stop();
    }
  });

  it('a password in the old format still works and is upgraded on login', async () => {
    const spx = await startServer({ general: { username: 'admin', password: legacyHash('pw') } });
    try {
      const { cookie } = await login(spx, 'admin', 'pw');
      assert.ok(cookie);
      assert.match(readConfig(spx).general.password, /^scrypt\$/);
      // and the upgraded hash works for the next login
      assert.ok((await login(spx, 'admin', 'pw')).cookie);
    } finally {
      await spx.stop();
    }
  });
});

describe('Socket relay to renderers (SPXWebRendererMessage)', () => {
  const relayed = async (spx, sender) => {
    const got = spx.listener.collect('SPXMessage2Client', 500);
    sender.emit('SPXWebRendererMessage', { spxcmd: 'forceWM', probe: true });
    return (await got).some((d) => d.probe);
  };

  it('without login: relays from same-site sockets, not from other sites', async () => {
    const spx = await startServer();
    try {
      const same = await openSocket(spx.baseUrl, { Origin: spx.baseUrl });
      const evil = await openSocket(spx.baseUrl, { Origin: EVIL });
      assert.equal(await relayed(spx, same), true);
      assert.equal(await relayed(spx, evil), false);
      same.close();
      evil.close();
    } finally {
      await spx.stop();
    }
  });

  it('with login: relays only from logged-in sessions', async () => {
    const spx = await startServer({ general: { username: 'admin', password: scryptHash('pw'), apikey: 'k' } });
    try {
      const anonymous = await openSocket(spx.baseUrl);
      assert.equal(await relayed(spx, anonymous), false);
      const { cookie } = await login(spx, 'admin', 'pw');
      const operator = await openSocket(spx.baseUrl, { Cookie: cookie });
      assert.equal(await relayed(spx, operator), true);
      anonymous.close();
      operator.close();
    } finally {
      await spx.stop();
    }
  });
});
