import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Render the real task panel with disposable data, including the long command
// summaries that used to widen Radix's table-based content wrapper.
const longPath = 'apps/school-site/src/' + 'nested-directory/'.repeat(24) + 'cookie-consent.tsx';
const command = '/bin/zsh -lc ' + 'cat ' + longPath + '; '.repeat(10) + 'pnpm typecheck';
const description = [
  '## Problem',
  'The school site shows a large cookie consent card. '.repeat(12),
  '- Our analytics setup already turns off ads, signals and personalization. '.repeat(4),
  '`' + longPath + '`',
  '[Long external link](https://example.com/' + 'path/'.repeat(30) + ')',
  '```text\n' + 'wide-code-output-'.repeat(100) + '\n```',
  '| First | Second |\n| --- | --- |\n| ' + 'wide-table-cell-'.repeat(100) + ' | value |',
].join('\n\n');
const task = {
  id: 'fixture', projectId: 'fixture', title: 'School site cookie banner: is it necessary?',
  description, status: 'ready', branchName: longPath, worktreePath: '/fixture',
  baseBranch: 'main', accessMode: 'fullAccess', createdBy: 'user',
  createdAt: '2026-10-06', updatedAt: '2026-10-06', additions: 201, deletions: 93,
  attachments: [], source: { provider: 'gitlab', externalId: 'issue:fixture', externalUrl: 'https://example.com/issue' },
  plan: { revision: 1, markdown: '## Plan\n\n' + description, steps: [] },
};
const events = [
  { id: 1, taskId: 'fixture', kind: 'assistant_message', payload: { text: description } },
  { id: 2, taskId: 'fixture', kind: 'command', payload: { command, exitCode: 0, output: 'output-'.repeat(500) } },
  { id: 3, taskId: 'fixture', kind: 'user_message', payload: { text: 'Please check `' + longPath + '`.' } },
];
const fixture = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import '/src/index.css'; import '/src/app-shell.css';
import { createElement as h } from 'react'; import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskPanel } from '/src/components/panels/chat-panel.tsx';
import { ScrollArea } from '/src/components/ui/scroll-area.tsx';
import { ApiClientProvider } from '/src/lib/api-context.tsx';
import { getActiveApiClient } from '/src/lib/api.ts';
import { useAppStore } from '/src/lib/store.ts'; import { useMachineStore } from '/src/lib/machines.ts';
useMachineStore.setState({ profiles: [{ id: 'fixture', name: 'Fixture', baseUrl: location.origin, createdAt: '2026-10-06' }], activeId: 'fixture' });
useAppStore.setState({ selectedTaskId: 'fixture' });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const width = new URLSearchParams(location.search).get('width') || '100%';
createRoot(document.getElementById('root')).render(h(QueryClientProvider, { client },
  h(ApiClientProvider, { client: getActiveApiClient() },
    h('main', { className: 'main-surface', style: { width, maxWidth: '100%', height: 'calc(100% - 60px)' } }, h(TaskPanel, { onClose: () => {} })),
    h(ScrollArea, { scrollbars: 'horizontal', className: 'horizontal-fixture h-12' }, h('div', { style: { width: 2400 } }, 'Intentionally wide horizontal content')))));
</script></body></html>`;

let server, url;
const browsers = new Map();
before(async () => {
  server = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'task-overflow-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith('/api/')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(req.url.includes('/events') ? events : req.url.endsWith('/tasks/fixture') ? task : []));
        } else if (req.url?.startsWith('/__task_overflow__')) {
          try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, fixture)); }
          catch (error) { next(error); }
        } else next();
      });
    } }],
  });
  await server.listen();
  url = 'http://127.0.0.1:' + server.httpServer.address().port + '/__task_overflow__';
  for (const [name, type] of Object.entries({ chromium, webkit })) browsers.set(name, await type.launch());
});
after(async () => { for (const browser of browsers.values()) await browser.close(); await server?.close(); });

for (const engine of ['chromium', 'webkit']) {
  test(engine + ' task descriptions and tool rows stay inside narrow and split panels', async (t) => {
    const page = await browsers.get(engine).newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [screenWidth, panelWidth] of [[320, 320], [432, 432], [820, 820], [1440, 432], [1440, 1000]]) {
      await page.setViewportSize({ width: screenWidth, height: 900 });
      await page.goto(url + '?width=' + panelWidth + 'px');
      await page.getByRole('heading', { name: task.title }).waitFor();
      const tool = page.getByRole('button', { name: command + ' exit 0' });
      await tool.waitFor();
      const viewport = page.locator('.chat-scroll [data-radix-scroll-area-viewport]');
      const checkWidth = async () => {
        const dimensions = await viewport.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }));
        assert.ok(dimensions.content <= dimensions.width + 1, JSON.stringify({ screenWidth, panelWidth, ...dimensions }));
        const bounds = await page.locator('.chat-scroll .aui-markdown, .chat-scroll button, .chat-scroll [data-slot="badge"]').evaluateAll(els => {
          const viewport = document.querySelector('.chat-scroll [data-radix-scroll-area-viewport]').getBoundingClientRect();
          return els.filter(el => { const r = el.getBoundingClientRect(); return r.left < viewport.left - 1 || r.right > viewport.right + 1; }).map(el => el.outerHTML.slice(0, 160));
        });
        assert.deepEqual(bounds, [], 'Markdown and complete command rows fit the viewport');
      };
      await checkWidth();
      await tool.click();
      await checkWidth();
      const code = page.locator('.chat-scroll pre').first();
      assert.ok(await code.evaluate(el => el.scrollWidth > el.clientWidth), 'wide code scrolls within its own block');
      await code.evaluate(el => { el.scrollLeft = 100; });
      assert.ok(await code.evaluate(el => el.scrollLeft > 0));
      const horizontal = page.locator('.horizontal-fixture [data-radix-scroll-area-viewport]');
      await horizontal.evaluate(el => { el.scrollLeft = 100; });
      assert.ok(await horizontal.evaluate(el => el.scrollLeft > 0), 'explicit horizontal scroll areas still work');
    }
    assert.deepEqual(errors, []);
  });
}
