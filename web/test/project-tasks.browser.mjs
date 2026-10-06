import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const projects = [
  { id: 'alpha', name: 'Alpha', repoPath: '/repos/alpha', defaultBranch: 'main', createdAt: '2026-10-07' },
  { id: 'beta', name: 'Beta', repoPath: '/repos/beta', defaultBranch: 'main', createdAt: '2026-10-07' },
];
const task = { id: 'task-a', projectId: 'alpha', title: 'Give projects a dedicated panel', description: 'Keep task context visible while managing work.', status: 'queued', branchName: 'boosted/project-panel', worktreePath: '/worktrees/task-a', baseBranch: 'main', accessMode: 'fullAccess', createdBy: 'user', createdAt: '2026-10-07', updatedAt: '2026-10-07', additions: 0, deletions: 0, attachments: [] };
const chat = { id: 'work-chat', projectId: 'alpha', taskId: task.id, title: 'Project panel', cwd: '/worktrees/task-a', status: 'idle', source: 'appServer', model: 'model', preview: '', isPinned: false, updatedAt: '2026-10-07' };
const options = { models: [{ id: 'model', model: 'model', displayName: 'Model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ id: 'high', description: '' }], inputModalities: [], isDefault: true }], defaultModel: 'model', defaultAccessMode: 'fullAccess', accessModes: [{ id: 'fullAccess', label: 'Full access', description: '' }] };
let events = [];
const fixture = `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import '/src/index.css'; import '/src/app-shell.css';
import { createElement as h } from 'react'; import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppShell } from '/src/components/app-shell.tsx'; import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
import { ApiClientProvider } from '/src/lib/api-context.tsx'; import { getActiveApiClient } from '/src/lib/api.ts';
import { useMachineStore } from '/src/lib/machines.ts'; import { useAppStore } from '/src/lib/store.ts';
useMachineStore.setState({profiles:[{id:'fixture',name:'Fixture',baseUrl:location.origin,createdAt:'2026-10-07'}],activeId:'fixture'});
useAppStore.setState({ selectedProjectId:'alpha' });
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(ApiClientProvider,{client:getActiveApiClient()},h(TooltipProvider,null,h(AppShell)))));
</script></body></html>`;
let server, url;
const browsers = new Map();
before(async () => {
  await mkdir('/tmp/boosted-project-tasks', { recursive: true });
  server = await createServer({ root: new URL('..', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, open: false }, plugins: [{ name: 'project-tasks-fixture', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith('/api/')) {
        const path = new URL(req.url, 'http://fixture').pathname.replace('/api/v1/', '/api/');
        let data = [];
        if (path === '/api/projects') data = projects;
        else if (path === '/api/tasks') data = req.url.includes('alpha') ? [task] : [];
        else if (path === '/api/tasks/task-a') data = task;
        else if (path === '/api/tasks/task-a/events') data = events;
        else if (path === '/api/tasks/task-a/messages' && req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk;
          const { message } = JSON.parse(body);
          const commentId = 'comment-' + events.length;
          events.push({ id: events.length + 1, taskId: task.id, kind: 'user_message', payload: { text: message, commentId, agentNames: ['Coral'] }, createdAt: 'now' });
          events.push({ id: events.length + 1, taskId: task.id, kind: 'agent_message', payload: { text: 'Started working in a chat', replyTo: commentId, agentId: 'coral', agentName: 'Coral', chatId: chat.id }, createdAt: 'now' });
          data = task;
        } else if (path === '/api/codex/chats') data = [chat];
        else if (path === '/api/codex/chats/work-chat') data = { chat, runtimeDefaults: { model: 'model', reasoningEffort: 'high', accessMode: 'fullAccess', collaborationMode: 'default' }, messages: [{ id: 'answer', role: 'assistant', kind: 'message', content: 'I can plan, implement, or answer questions here.' }] };
        else if (path === '/api/codex/options') data = options;
        else if (path.endsWith('/git/branch')) data = { branch: 'main' };
        else if (path.endsWith('/git/branches')) data = ['main'];
        else if (path === '/api/features/agents' || path === '/api/agents') data = [{ id: 'coral', profile: { name: 'Coral' }, status: 'idle', accountId: null, createdAt: 'now', updatedAt: 'now' }];
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return;
      }
      if (!req.url?.startsWith('/__project_tasks__')) return next();
      try { res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml(req.url, fixture)); } catch (error) { next(error); }
    });
  } }] });
  await server.listen(); url = 'http://127.0.0.1:' + server.httpServer.address().port + '/__project_tasks__#projects';
  for (const [name, type] of Object.entries({ chromium, webkit })) browsers.set(name, await type.launch());
});
after(async () => { for (const browser of browsers.values()) await browser.close(); await server?.close(); });

for (const engine of ['chromium', 'webkit']) test(engine + ' project task comments and linked chats stay in the project workspace', async (t) => {
  for (const width of [1440, 1024, 390, 320]) {
    events = [];
    const page = await browsers.get(engine).newPage({ viewport: { width, height: 900 } });
    t.after(() => page.close());
    page.setDefaultTimeout(8_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    try { await page.locator('.app-frame').waitFor(); } catch (error) { t.diagnostic(JSON.stringify(errors)); t.diagnostic((await page.locator('body').innerText()).slice(0, 1000)); throw error; }
    await page.screenshot({ path: `/tmp/boosted-project-tasks/${engine}-${width}-initial.png`, fullPage: true });
    if (width > 700) await page.getByRole('region', { name: 'Project folders' }).getByRole('button', { name: 'Alpha', exact: true }).click();
    else await page.getByRole('region', { name: 'Projects page' }).locator('.project-page-copy').filter({ hasText: 'Alpha' }).click();
    await page.getByRole('button', { name: /Give projects a dedicated panel/ }).click();
    const input = page.getByRole('textbox', { name: 'Task comment' });
    await input.fill('@Co');
    try { await page.getByRole('option', { name: 'Mention Coral' }).waitFor(); } catch (error) { t.diagnostic(JSON.stringify(await input.evaluate(el => ({value:el.value,cursor:el.selectionStart,html:el.closest('.task-comment-composer').innerHTML})))); t.diagnostic(JSON.stringify(errors)); throw error; }
    await input.press('Enter');
    assert.equal(await input.inputValue(), '@Coral ');
    await input.fill('@Coral please plan this task');
    await page.getByRole('button', { name: 'Send comment' }).click();
    const reply = page.getByRole('article', { name: 'Reply from Coral' });
    await reply.waitFor();
    assert.equal(await page.getByRole('button', { name: 'Start planning' }).count(), 0);
    await page.screenshot({ path: `/tmp/boosted-project-tasks/${engine}-${width}.png`, fullPage: true });
    const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(overflow.document <= overflow.viewport + 1, JSON.stringify(overflow));
    const composer = await input.boundingBox(); assert.ok(composer.width > 140, 'comment input remains usable');
    await reply.getByRole('button', { name: /Open chat/ }).click();
    await page.getByText('I can plan, implement, or answer questions here.').waitFor();
    assert.equal(await page.getByRole('region', { name: 'Projects page' }).count(), 1);
    await page.getByRole('button', { name: 'Back to task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Task comment' }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
});
