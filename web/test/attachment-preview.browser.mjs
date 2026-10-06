import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><div id="root"></div><script type="module">
import '/src/index.css';
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttachmentPreviewLayout } from '/src/components/attachment-preview-layout.tsx';
import { AttachmentPreview } from '/src/components/attachment-preview.tsx';
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="royalblue"/></svg>');
function App() {
  const [split,setSplit] = useState(false);
  return h('div',{style:{height:'100dvh'}},h(AttachmentPreviewLayout,{alreadySplit:split},
    h('textarea',{'aria-label':'Chat composer'}),
    h('button',{onClick:()=>setSplit(s=>!s)},'Toggle existing split'),
    h(AttachmentPreview,{name:'remote-image.svg',mimeType:'image/svg+xml',src:image}),
    h(AttachmentPreview,{name:'notes.txt',src:'data:text/plain,Remote%20file%20contents'})));
}
createRoot(document.getElementById('root')).render(h(App));
</script></body></html>`;

let server;
let browser;
let baseUrl;
let policy;
before(async () => {
  const config = JSON.parse(await readFile(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  policy = config.app.security.csp;
  server = await createServer({
    configFile: new URL('../vite.config.ts', import.meta.url).pathname,
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'attachment-preview-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__preview') {
          res.setHeader('Content-Type', 'text/html');
          res.end(await vite.transformIndexHtml(req.url, fixture));
        } else if (req.url?.startsWith('/__csp')) {
          res.setHeader('Content-Type', 'text/html');
          res.setHeader('Content-Security-Policy', req.url === '/__csp-old'
            ? policy.replace(' wss: data: blob:', ' wss:').replace("; media-src 'self' data: blob:; frame-src 'self' blob:", '')
            : policy);
          res.end('<!doctype html><title>Desktop security policy</title><body></body>');
        } else next();
      });
    } }],
  });
  await server.listen();
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

test('desktop policy permits attachment fetches and blob-backed media and documents', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/__csp-old`);
    assert.equal(await page.evaluate(() => fetch('data:text/plain,attachment').then(() => true, () => false)), false);
    await page.goto(`${baseUrl}/__csp`);
    const fetched = await page.evaluate(async () => {
      const data = await fetch('data:text/plain,attachment').then(r => r.blob());
      const url = URL.createObjectURL(data);
      try { return await fetch(url).then(r => r.text()); }
      finally { URL.revokeObjectURL(url); }
    });
    assert.equal(fetched, 'attachment');
    await page.evaluate(() => {
      window.blocked = [];
      document.addEventListener('securitypolicyviolation', e => window.blocked.push(e.effectiveDirective));
      const audio = document.createElement('audio');
      audio.src = URL.createObjectURL(new Blob(['audio'], {type:'audio/wav'}));
      audio.preload = 'auto';
      const frame = document.createElement('iframe');
      frame.src = URL.createObjectURL(new Blob(['<p>Preview document</p>'], {type:'text/html'}));
      document.body.append(audio, frame);
    });
    await page.frameLocator('iframe').getByText('Preview document').waitFor();
    assert.deepEqual(await page.evaluate(() => window.blocked), []);
  } finally { await page.close(); }
});

test('preview splits, detaches, and adapts to narrow or already split chats', async () => {
  const page = await browser.newPage({ viewport: {width:1200,height:800} });
  try {
    await page.goto(`${baseUrl}/__preview`);
    const view = page.getByRole('button', {name:'View remote-image.svg'});
    await view.click();
    const pane = page.getByRole('complementary', {name:'File preview'});
    await pane.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('textbox', {name:'Chat composer'}).fill('Keep chatting');
    assert.equal(await page.getByRole('textbox').inputValue(), 'Keep chatting');
    await pane.getByRole('button', {name:'Zoom in'}).click();
    await pane.getByRole('button', {name:'Detach'}).click();
    await page.getByRole('dialog', {name:'remote-image.svg'}).waitFor();
    assert.equal(await page.getByLabel('Zoom level').textContent(), '125%');
    await page.getByRole('button', {name:'Close',exact:true}).click();
    await view.click();
    await pane.waitFor();
    await page.setViewportSize({width:700,height:800});
    await page.getByRole('dialog', {name:'remote-image.svg'}).waitFor();
    await page.getByRole('button', {name:'Close',exact:true}).click();
    await page.setViewportSize({width:1200,height:800});
    await page.getByRole('button', {name:'Toggle existing split'}).click();
    await page.getByRole('button', {name:'View notes.txt'}).click();
    await page.getByRole('dialog', {name:'notes.txt'}).getByText('Remote file contents').waitFor();
  } finally { await page.close(); }
});
