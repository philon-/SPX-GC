// Values from project profiles, templates and app config are escaped when
// the server builds HTML (Handlebars helpers in server.js).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers/spx-server');

describe('HTML built by the server', () => {
  it('escapes profile and template values in the controller page', async () => {
    const spx = await startServer({ casparcg: true });
    try {
      const profileFile = path.join(spx.dir, 'DATAROOT', 'MyFirstProject', 'profile.json');
      const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      profile.showExtras = profile.showExtras || {};
      profile.showExtras.CustomControls = [
        { ftype: 'button', description: '<b id="desc">', text: '"><img id="txt">', fcall: "demo_popup('hi')", bgclass: 'bg_blue' },
      ];
      profile.templates[0].description = '<img id="tdesc" src=x>';
      fs.writeFileSync(profileFile, JSON.stringify(profile));

      const html = await (await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).text();
      assert.ok(!html.includes('<b id="desc">'), 'control description not escaped');
      assert.ok(html.includes('&lt;b id=&quot;desc&quot;&gt;'));
      assert.ok(!html.includes('<img id="txt">'), 'control text not escaped');
      assert.ok(!html.includes('<img id="tdesc"'), 'template description not escaped');
      // fcall is JavaScript by design: still works once the attribute is decoded.
      assert.ok(html.includes('onClick="demo_popup(&#39;hi&#39;)"'));
    } finally {
      await spx.stop();
    }
  });

  it('language strings are looked up without eval', async () => {
    const spx = await startServer();
    try {
      const html = await (await fetch(`${spx.baseUrl}/gc/MyFirstProject/MyFirstRundown`)).text();
      const english = JSON.parse(fs.readFileSync(path.join(spx.dir, 'locales', 'english.json'), 'utf8'));
      assert.ok(html.includes(english.button.play), 'button.play string rendered');
    } finally {
      await spx.stop();
    }
  });
});
