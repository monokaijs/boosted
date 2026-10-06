import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Use the real pre-paint script, Settings, and editor with disposable project data.
const root = fileURLToPath(new URL('..', import.meta.url));
const html = (await readFile(path.join(root, 'index.html'), 'utf8')).replace(
  '<script type="module" src="/src/main.tsx"></script>',
  `<script>window.themeBeforeMount = {dark: document.documentElement.classList.contains('dark'), colorScheme: document.documentElement.style.colorScheme};</script>
  <script type="module">
  import '/src/index.css'; import '/src/app-shell.css';
  import { createElement as h, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { SettingsPage } from '/src/components/settings-page.tsx';
  import { EditorPanel } from '/src/components/panels/editor-panel.tsx';
  import { useAppStore } from '/src/lib/store.ts';
  import { useMachineStore } from '/src/lib/machines.ts';
  import { initializeTheme } from '/src/lib/theme.ts';
  initializeTheme();
  useMachineStore.setState({profiles:[{id:'fixture',name:'Fixture',baseUrl:location.origin,createdAt:'2026-10-06'}],activeId:'fixture'});
  useAppStore.setState({selectedProjectId:'fixture',openFilePath:'src/example.ts'});
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  function App() {
    const [section,setSection] = useState('appearance');
    return h('div',{className:'app-frame','data-page':'settings'},
      h('header',{className:'shell-titlebar'},'Boosted'),
      h('div',{className:'content-surface',style:{gridTemplateColumns:'minmax(0,1fr)'}},
        h('main',{className:'main-surface'},h(SettingsPage,{section,onSectionChange:setSection,onBack:()=>setSection(undefined),onClose:()=>{}}))),
      h('aside',{className:'theme-editor-fixture'},h(EditorPanel)));
  }
  createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(App)));
  </script>
  <style>
    .app-frame {grid-template-columns:minmax(0,1fr) 420px;padding-right:8px;gap:8px}
    .theme-editor-fixture {grid-column:2;grid-row:2;overflow:hidden;border:1px solid var(--border);border-radius:18px}
    @media(max-width:900px) {.app-frame {grid-template-columns:minmax(0,1fr);padding:0;gap:0}.theme-editor-fixture {display:none}}
  </style>`,
);

const artifactDir = process.env.BOOSTED_BROWSER_ARTIFACTS ?? path.join(tmpdir(), 'boosted-theme');
const browsers = new Map();
let server, url;
before(async () => {
  server = await createServer({root, server:{host:'127.0.0.1',port:0,strictPort:false}, plugins:[{
    name:'theme-fixture', configureServer(vite) {
      vite.middlewares.use(async (req,res,next) => {
        if (req.url?.startsWith('/api/v1/projects/fixture/file')) {
          res.setHeader('Content-Type','application/json');
          res.end(JSON.stringify({path:'src/example.ts',content:'// A theme-aware coding workspace\nexport const greeting = "Hello, Boosted";\n',revision:'fixture',language:'typescript',binary:false}));
          return;
        }
        if (!req.url?.startsWith('/__theme__')) return next();
        try {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,html));} catch(error) {next(error);}
      });
    },
  }]});
  await server.listen();
  url = 'http://127.0.0.1:'+server.httpServer.address().port+'/__theme__';
  await mkdir(artifactDir,{recursive:true});
  for (const [name,type] of Object.entries({chromium,webkit})) browsers.set(name,await type.launch());
});
after(async () => {for (const browser of browsers.values()) await browser.close();await server?.close();});

async function chooseTheme(page, name) {
  await page.getByRole('combobox',{name:'Theme',exact:true}).click();
  await page.getByRole('option',{name,exact:true}).click();
}
async function assertTheme(page, theme) {
  const dark = theme === 'dark';
  await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, dark);
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).colorScheme),theme);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'),dark?'#08090b':'#edf0f3');
  assert.equal(await page.locator('.main-surface').evaluate(el=>getComputedStyle(el).backgroundColor),dark?'rgb(14, 16, 19)':'rgb(255, 255, 255)');
  // Wait for the shared controls' color transitions before checking contrast or capturing screenshots.
  await page.waitForFunction(color=>getComputedStyle(document.querySelector('.settings-select')).color === color,dark?'rgb(231, 233, 237)':'rgb(32, 36, 43)');
}

for (const engine of ['chromium','webkit']) {
  test(engine+' switches themes, restores before mount, and updates the editor and other tabs',async(t)=>{
    const context = await browsers.get(engine).newContext({viewport:{width:1440,height:900},colorScheme:'light'});
    t.after(()=>context.close());
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole('combobox',{name:'Theme',exact:true}).waitFor();
    await assertTheme(page,'light');
    await page.locator('.monaco-editor').waitFor({timeout:30000});
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === 'rgb(255, 255, 255)');
    await page.screenshot({path:path.join(artifactDir,engine+'-light.png')});
    await chooseTheme(page,'Dark');
    await assertTheme(page,'dark');
    await page.waitForFunction(()=>getComputedStyle(document.querySelector('.monaco-editor')).backgroundColor === 'rgb(14, 16, 19)');
    await page.screenshot({path:path.join(artifactDir,engine+'-dark.png')});
    await page.reload();
    await page.getByRole('combobox',{name:'Theme',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.themeBeforeMount),{dark:true,colorScheme:'dark'});
    await page.emulateMedia({colorScheme:'light'});
    await assertTheme(page,'dark');
    const other = await context.newPage();
    await other.goto(url);
    await other.getByRole('combobox',{name:'Theme',exact:true}).waitFor();
    await chooseTheme(page,'Light');
    await assertTheme(other,'light');
    await chooseTheme(page,'System');
    await page.emulateMedia({colorScheme:'dark'});
    await assertTheme(page,'dark');
    await page.emulateMedia({colorScheme:'light'});
    await assertTheme(page,'light');
    await page.reload();
    await page.getByRole('combobox',{name:'Theme',exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.themeBeforeMount),{dark:false,colorScheme:'light'});
  });

  test(engine+' exposes Appearance and theme choices on a narrow mobile screen',async(t)=>{
    const context = await browsers.get(engine).newContext({viewport:{width:320,height:640},hasTouch:true,colorScheme:'dark'});
    t.after(()=>context.close());
    const page = await context.newPage();
    await page.goto(url);
    await page.getByRole('combobox',{name:'Theme',exact:true}).waitFor();
    await assertTheme(page,'dark');
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByRole('button',{name:'Appearance',exact:true}).click();
    await chooseTheme(page,'Light');
    await assertTheme(page,'light');
    const bounds = await page.getByRole('combobox',{name:'Theme',exact:true}).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x+ bounds.width <= 320);
    await page.screenshot({path:path.join(artifactDir,engine+'-mobile-light.png')});
    await chooseTheme(page,'Dark');
    await assertTheme(page,'dark');
    await page.screenshot({path:path.join(artifactDir,engine+'-mobile-dark.png')});
  });
}
