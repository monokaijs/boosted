import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const artifactDir = process.env.HISTORY_REVIEW_DIR;
const requests = [];
const assertions = [];
let server, browser, baseUrl;
let failTool = true;
const chat = { id: 'chat', title: 'History', status: 'idle', cwd: '/repo', preview: '', source: 'cli', updatedAt: '2026-10-01', isPinned: false };
const options = { models: [{ id: 'model', model: 'model', displayName: 'Model', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ id: 'high' }], inputModalities: [] }], accessModes: [{ id: 'fullAccess', label: 'Full access' }], defaultModel: 'model', defaultAccessMode: 'fullAccess' };
const agentBase = { id: 'agent', profile: { name: 'Nova', personality: '' }, status: 'idle', accountId: null, error: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', followUps: [] };
const taskBase = { id: 'task', projectId:'project', title:'Task history',description:'Review the conversation',status:'ready',branchName:'branch',worktreePath:'/repo',baseBranch:'main',accessMode:'fullAccess',createdBy:'user',createdAt:'2026-10-01',updatedAt:'2026-10-01',additions:0,deletions:0,attachments:[] };
const groupBase = { id: 'group', name: 'Team', memberIds: ['agent'], memberRoles: { agent: { role: 'coordinator', roles: ['coordinator'], responsibilities: '' } }, members: [{ id: 'agent', profile: agentBase.profile, accountId: null }], stopped: false, projectId: null, workingDirectory: null, version: 1, messageCount: 1000, deliveries: [], tasks: [], executions: [], receipts: [], reviews: [], requests: [], createdAt: agentBase.createdAt, updatedAt: agentBase.updatedAt };
function messages(surface, end) {
  return Array.from({ length: Math.min(50,end) }, (_, index) => {
    const n = Math.max(0,end-50)+index;
    const role = n%2 ? 'assistant' : 'user';
    const item = { id: `m${n}`, role, sequence: n, content: `Message ${n} — ${'history text '.repeat(12)}`, createdAt: new Date(Date.UTC(2026,9,1,0,n)).toISOString() };
    if (surface === 'coding') return { ...item, role: n === 998 ? 'assistant' : role, kind: n === 998 ? 'tool' : 'message', ...(n === 998 ? { content: '**Command** · completed', detailRevision: 'rev1' } : {}) };
    if (surface === 'task') return { id:n+1, taskId:'task', kind:role==='user'?'user_message':'agent_message', payload:{text:item.content}, createdAt:item.createdAt };
    if (surface === 'group') return { ...item, sequence: n+1, groupId: 'group', rootId: item.id, senderType: role === 'user' ? 'user' : 'agent', senderId: role === 'user' ? 'user' : 'agent', senderName: role === 'user' ? 'User' : 'Nova', recipientIds: [], kind: 'message' };
    return item;
  });
}
function page(surface, before) {
  const end = before == null ? 1000 : ['group','task'].includes(surface) ? Number(before)-1 : Number(before.replace(/^m/,''));
  const data = messages(surface,end);
  return { messages: data, olderCursor: end > 50 ? ['group','task'].includes(surface) ? String(end-49) : `m${end-50}` : null };
}
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style><div id="root"></div><script type="module">
import '/src/index.css';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider } from '/src/lib/api-context.tsx';
import { CodexChatPanel } from '/src/components/panels/codex-chat-panel.tsx';
import { TaskPanel } from '/src/components/panels/chat-panel.tsx';
import { GroupPanel } from '/src/features/groups/group-panel.tsx';
import { AssistantPage } from '/src/features/agents/components/session/assistant-page.tsx';
import { apiClient } from '/src/features/agents/lib/api-client.ts';
import { useAppStore } from '/src/lib/store.ts';
import { applyCodexEvent } from '/src/lib/codex-chat-state.ts';
const surface = new URL(location.href).searchParams.get('surface') || 'coding';
const get = async path => { const r=await fetch(path); if(!r.ok)throw new Error('Detail temporarily unavailable'); return r.json(); };
const options = ${JSON.stringify(options)};
const client = { task:async()=>(${JSON.stringify(taskBase)}), taskHistory:(_,before)=>get('/fixture/task'+(before?'?before='+before:'')), profileId:'review', cancelRequests:()=>{}, codexChat:()=>get('/fixture/coding'), codexHistory:(_,before)=>get('/fixture/coding?before='+before), codexToolDetail:()=>get('/fixture/tool'), threadCodexOptions:async()=>options, codexApprovals:async()=>[], projects:async()=>[], codexChats:async()=>[], featureRequest:async(path)=> {
  if(path==='/agents')return [];
  if(path.includes('?before=')) { const p=await get('/fixture/group?before='+path.split('?before=')[1]); return p.messages; }
  return get('/fixture/group');
} };
apiClient.assistant.read=()=>get('/fixture/agent');
apiClient.assistant.history=(_,before)=>get('/fixture/agent?before='+before);
apiClient.providerAccounts.list=async()=>[];
useAppStore.setState({user:{id:'user',username:'User'},activeMachineId:'review',selectedTaskId:'task'});
const queryClient = new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});
window.queryClient=queryClient;
window.arrive=()=>applyCodexEvent(queryClient,{threadId:'chat',method:'item/completed',message:{id:'m1000',role:'assistant',kind:'message',content:'Live arrival during pagination'}});
const shell = { agents:[${JSON.stringify(agentBase)}], chats:[], chatAccounts:[], recentWorkspaces:[], updateAgent:()=>{}, selectManagementView:()=>{} };
const panel = surface==='task' ? h(TaskPanel) : surface==='group' ? h(GroupPanel,{groupId:'group'}) : surface==='agent' ? h(AssistantPage,{shell,agentId:'agent'}) : h(CodexChatPanel,{threadId:'chat'});
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client:queryClient},h(ApiClientProvider,{client},h('main',{style:{height:'100dvh',display:'flex',flexDirection:'column'}},panel))));
</script></body></html>`;
before(async () => {
  server = await createServer({ configFile: new URL('../vite.config.ts',import.meta.url).pathname, root: new URL('..',import.meta.url).pathname, server:{host:'127.0.0.1',port:0}, plugins:[{name:'history-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/__history'){res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,fixture));return;}
    if(!url.pathname.startsWith('/fixture/'))return next();
    const surface=url.pathname.slice('/fixture/'.length);
    let data;
    if(surface==='tool') { requests.push({surface,bytes:0}); if(failTool){failTool=false;res.statusCode=503;res.end('{}');return;} data={id:'m998',kind:'tool',role:'assistant',content:'Full tool arguments and output loaded on demand'}; }
    else { const p=page(surface,url.searchParams.get('before')); data=surface==='coding' ? {...p,chat} : surface==='agent' ? {...agentBase,...p} : surface==='task' ? p : {...groupBase,...p}; requests.push({surface,before:url.searchParams.get('before'),messages:p.messages.length,bytes:Buffer.byteLength(JSON.stringify(data))}); }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
  });}}] });
  await server.listen();baseUrl='http://127.0.0.1:'+server.httpServer.address().port;browser=await chromium.launch({headless:true,...(process.env.HISTORY_BROWSER_CHANNEL ? { channel: process.env.HISTORY_BROWSER_CHANNEL } : {})});
  if(artifactDir)await mkdir(artifactDir,{recursive:true});
});
after(async()=>{if(artifactDir){await writeFile(artifactDir+'/browser-network.json',JSON.stringify(requests,null,2));await writeFile(artifactDir+'/browser-assertions.json',JSON.stringify(assertions,null,2));}await browser?.close();await server?.close();});
for(const surface of ['group','agent','coding','task'])test(surface+' bounds initial history and preserves scroll when prepending',async()=>{
  const tab=await browser.newPage({viewport:{width:1100,height:800}});
  try{
    await tab.goto(baseUrl+'/__history?surface='+surface);
    const earlier=tab.getByRole('button',{name:'Load earlier messages',exact:true});await earlier.waitFor();
    const key=surface==='coding'?['codex-chat','chat']:surface==='group'?['groups','group']:surface==='task'?['events','task']:['assistant-state','agent'];
    await tab.waitForFunction(key=>window.queryClient.getQueryData(key)?.messages.length===50,key);
    assert.equal(requests.filter(r=>r.surface==='tool').length,0);
    const viewport=tab.locator(surface==='coding'?'.codex-thread-viewport':surface==='task'?'[data-radix-scroll-area-viewport]':'.assistant-conversation-scroll');
    await viewport.evaluate(el=>{el.scrollTop=80;});await tab.waitForTimeout(100);
    const selector=surface==='coding'?'[id^="codex-message-"]':'[data-history-id]';
    const id=await viewport.evaluate((node,selector)=>Array.from(node.querySelectorAll(selector)).find(el=>el.getBoundingClientRect().bottom>node.getBoundingClientRect().top)?.getAttribute(selector.includes('data-history')?'data-history-id':'id'),selector);
    const anchor=surface==='coding'?tab.locator('[id="'+id+'"]'):tab.locator('[data-history-id="'+id+'"]');const before=(await anchor.boundingBox()).y;
    await earlier.evaluate(el=>el.click());
    await tab.waitForFunction(key=>window.queryClient.getQueryData(key)?.messages.length===100,key);
    const retained=surface==='coding'?tab.locator('[id="'+id+'"]'):tab.locator('[data-history-id="'+id+'"]');
    await tab.waitForTimeout(200);const after=(await retained.boundingBox()).y;
    assert.ok(Math.abs(after-before)<3,'anchor shifted '+(after-before)+'px');
    assertions.push({surface,initialMessages:50,messagesAfterOlderPage:100,scrollAnchorShiftPx:after-before,detailRequestsBeforeExpansion:requests.filter(r=>r.surface==='tool').length});
    if(artifactDir)await tab.screenshot({path:artifactDir+'/'+surface+'-paginated.png'});
  }finally{await tab.close();}
});
test('existing coding tool disclosure fetches only on expansion and supports retry and cached reopen',async()=>{
  const tab=await browser.newPage({viewport:{width:1100,height:800}});
  try{
    await tab.goto(baseUrl+'/__history?surface=coding');await tab.getByRole('button',{name:'Load earlier messages',exact:true}).waitFor();
    assert.equal(requests.filter(r=>r.surface==='tool').length,0);
    await tab.getByRole('button',{name:/Worked for/}).last().click();
    assert.equal(requests.filter(r=>r.surface==='tool').length,0);
    const disclosure=tab.locator('.codex-activity-item summary').last();await disclosure.click();
    await tab.getByRole('button',{name:'Retry tool details'}).waitFor();assert.equal(requests.filter(r=>r.surface==='tool').length,1);
    await tab.getByRole('button',{name:'Retry tool details'}).click();await tab.getByText('Full tool arguments and output loaded on demand').waitFor();
    assert.equal(requests.filter(r=>r.surface==='tool').length,2);
    await disclosure.click();await disclosure.click();await tab.waitForTimeout(100);assert.equal(requests.filter(r=>r.surface==='tool').length,2);
    assertions.push({surface:'coding-tool',detailRequestsBeforeExpansion:0,detailRequestsAfterActivityExpansion:0,detailRequestsAfterToolExpansion:1,detailRequestsAfterRetry:2,detailRequestsAfterCachedReopen:2});
    if(artifactDir)await tab.screenshot({path:artifactDir+'/tool-expanded.png'});
  }finally{await tab.close();}
});
