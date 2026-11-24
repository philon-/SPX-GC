// Test helper: starts a real SPX-GC server (node server.js) in an isolated
// temporary folder and connects a socket.io client to it.
//
// The socket client stands in for an open SPX controller page / web renderer:
// API calls such as /api/v1/item/play are delivered to those pages as
// socket.io messages, so tests assert on what the client receives.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_FOLDERS = ['ASSETS', 'DATAROOT', 'locales'];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Copy the git-tracked runtime files (same set a release build ships), so
// local, untracked user content never influences test results.
function copyRuntimeFiles(destDir) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...RUNTIME_FOLDERS], { cwd: ROOT, encoding: 'utf8' });
  for (const rel of out.split('\0').filter(Boolean)) {
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
}

function writeConfig(dir, port, general) {
  const slash = (p) => p.replace(/\\/g, '/') + '/';
  const config = {
    general: {
      username: '',
      password: '',
      hostname: 'spx-test',
      greeting: '',
      langfile: 'english.json',
      loglevel: 'warn',
      launchBrowser: false,
      apikey: '',
      logfolder: slash(path.join(dir, 'LOG')),
      dataroot: slash(path.join(dir, 'DATAROOT')),
      templatesource: 'spx-ip-address',
      port,
      disableConfigUI: false,
      disableLocalRenderer: false,
      disableOpenFolderCommand: false,
      disableSeveralControllersWarning: true,
      hideRendererCursor: false,
      resolution: 'HD',
      preview: 'selected',
      renderer: 'normal',
      autoplayLocalRenderer: true,
      recents: [],
      ...general,
    },
    casparcg: { servers: [] },
    osc: { enable: false, port: 57121 },
    globalExtras: { customscript: '/ExtraFunctions/demoFunctions.js', CustomControls: [] },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

class SocketListener {
  constructor(url) {
    this.messages = []; // { event, data }
    this.waiters = [];
    this.socket = io(url, { transports: ['websocket'], reconnection: false });
    for (const event of ['SPXMessage2Controller', 'SPXMessage2Client']) {
      this.socket.on(event, (data) => this._receive(event, data));
    }
  }

  connected() {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('connect_error', reject);
    });
  }

  _receive(event, data) {
    this.messages.push({ event, data });
    this.waiters = this.waiters.filter((w) => {
      if (w.event === event && w.match(data)) {
        clearTimeout(w.timer);
        w.resolve(data);
        return false;
      }
      return true;
    });
  }

  // Resolves with the first message (received from now on) on `event`
  // for which match(data) is true. Call BEFORE triggering the request.
  next(event, match = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const waiter = { event, match, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`Timed out waiting for ${event} message`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  // Collects all messages on `event` that arrive during `ms`.
  async collect(event, ms = 300) {
    const start = this.messages.length;
    await new Promise((r) => setTimeout(r, ms));
    return this.messages.slice(start).filter((m) => m.event === event).map((m) => m.data);
  }

  close() {
    this.socket.close();
  }
}

// Starts a server. `general` overrides config.general values.
async function startServer({ general = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spx-test-'));
  copyRuntimeFiles(dir);
  const port = await freePort();
  writeConfig(dir, port, general);

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`SPX server exited (${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${baseUrl}/api/v1/version`);
      if (res.ok) break;
    } catch (e) {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`SPX server did not start:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const listener = new SocketListener(baseUrl);
  await listener.connected();

  return {
    dir,
    port,
    baseUrl,
    listener,
    output: () => output,
    readRundown(project, rundown) {
      return JSON.parse(fs.readFileSync(path.join(dir, 'DATAROOT', project, 'data', `${rundown}.json`), 'utf8'));
    },
    async stop() {
      listener.close();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill();
        await exited;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

module.exports = { startServer };
