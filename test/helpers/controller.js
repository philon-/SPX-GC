// Opens the real SPX controller page (/gc/<project>/<rundown>) in jsdom,
// with its scripts and socket.io connection, so tests can check how an open
// controller reacts to API calls (e.g. a Companion button press).
//
// The embedded preview renderer frame is not loaded: it is not needed for
// controller behaviour and would register as an extra renderer.

const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');

class NoRendererLoader extends ResourceLoader {
  fetch(url, options) {
    if (/\/renderer\b/.test(new URL(url).pathname)) {
      return Promise.resolve(Buffer.from('<!doctype html><html><body></body></html>'));
    }
    return super.fetch(url, options);
  }
}

async function openController(baseUrl, project, rundown) {
  const virtualConsole = new VirtualConsole();
  const logs = [];
  let reloads = 0;
  virtualConsole.on('jsdomError', (e) => {
    // jsdom does not implement navigation; location.reload() reports this.
    if (/navigation/i.test(e.message)) reloads++;
    else logs.push('error: ' + e.message);
  });
  for (const level of ['log', 'warn', 'error']) {
    virtualConsole.on(level, (...args) => logs.push(level + ': ' + args.join(' ')));
  }

  const dom = await JSDOM.fromURL(`${baseUrl}/gc/${project}/${rundown}`, {
    runScripts: 'dangerously',
    resources: new NoRendererLoader(),
    pretendToBeVisual: true,
    virtualConsole,
  });
  const window = dom.window;

  // Ready when the page's socket is connected and the rows are rendered.
  const deadline = Date.now() + 15000;
  while (!(window.socket && window.socket.connected && window.document.querySelector('.itemrow'))) {
    if (Date.now() > deadline) throw new Error('Controller page did not get ready:\n' + logs.join('\n'));
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300)); // let it identify itself to the server

  const row = (itemID) =>
    [...window.document.querySelectorAll('.itemrow')].find((r) => r.getAttribute('data-spx-epoch') === itemID);

  return {
    window,
    logs,
    reloads: () => reloads,
    row,
    onair: (itemID) => row(itemID)?.getAttribute('data-spx-onair'),
    async waitFor(predicate, timeoutMs = 5000) {
      const end = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > end) throw new Error('Timed out waiting for the controller');
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async close() {
      window.socket?.disconnect();
      await new Promise((r) => setTimeout(r, 500)); // let pending requests settle
      window.close();
    },
  };
}

module.exports = { openController };
