import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

// Production components with disposable data. No user account or backend is used.
// Keyboard geometry and touch input here are simulations, not real iOS Safari.
export const fixture = `<!doctype html><html class="dark"><head>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<title>Boosted mobile UX regression</title></head><body><div id="root"></div><script type="module">
import '/src/index.css'; import '/src/app-shell.css';
import { createElement as h, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssistantRuntimeProvider, useExternalStoreRuntime, ThreadPrimitive, ComposerPrimitive, MessagePrimitive } from '@assistant-ui/react';
import { CodexThreadLayout } from '/src/components/panels/codex-thread-layout.tsx';
import { SettingsPage } from '/src/components/settings-page.tsx';
import { ConnectionsDialog } from '/src/components/machine-manager.tsx';
import { navigateSettings, backToSettings, settingsSectionFromHash } from '/src/lib/navigation.ts';
import { useMachineStore } from '/src/lib/machines.ts';
import { trackVisibleViewport } from '/src/lib/viewport.ts';
// In-memory profile only; fixture API reads return empty results in the test server.
useMachineStore.setState({profiles:[{id:'fixture',name:'Fixture',baseUrl:location.origin,createdAt:'2026-10-05'}],activeId:'fixture'});
const initialViewport = window.visualViewport;
const simulatedViewport = Object.assign(new EventTarget(), {height:innerHeight,width:innerWidth,offsetTop:0,scale:1});
Object.defineProperty(window,'visualViewport',{configurable:true,value:simulatedViewport});
trackVisibleViewport();
window.keyboardGeometry = (height, top=0) => { simulatedViewport.height=height; simulatedViewport.offsetTop=top; simulatedViewport.dispatchEvent(new Event('resize')); };
window.addEventListener('resize', () => {simulatedViewport.width=innerWidth; simulatedViewport.height=innerHeight; simulatedViewport.offsetTop=0; simulatedViewport.dispatchEvent(new Event('resize'));});
const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
const messages = Array.from({length:80},(_,i)=>({id:'message-'+i,role:'assistant',content:[{type:'text',text:'Message '+i+' — Long thread regression text.'}]}));
const Message = () => h(MessagePrimitive.Root,{className:'selectable-text',style:{padding:'20px 0'}},h(MessagePrimitive.Content));
function Conversation() {
 const [sent,setSent]=useState(0);
 const runtime = useExternalStoreRuntime({messages,isRunning:false,convertMessage:m=>m,onNew:()=>setSent(n=>n+1)});
 const footer = h('div',{className:'rounded-lg border border-border p-2'},
   h(ComposerPrimitive.Root,null,
     h(ComposerPrimitive.Input,{'aria-label':'Composer',placeholder:'Message Codex...',className:'max-h-40 min-h-14 w-full resize-none bg-transparent px-1 py-1 outline-none',style:{overflowY:'auto'}}),
     h('div',{className:'composer-surround',style:{height:'32px',padding:'4px',display:'flex',justifyContent:'space-between'}},'Composer controls',h(ComposerPrimitive.Send,{'aria-label':'Send draft'},'Send draft'))),
   h(ThreadPrimitive.ScrollToBottom,{'aria-label':'Scroll to bottom',style:{position:'absolute',top:'-32px',right:0}},'Scroll to bottom'),
   h('output',{'aria-label':'Sent drafts',className:'sr-only'},sent));
 const transcript = h(ThreadPrimitive.Messages,{components:{AssistantMessage:Message,UserMessage:Message}});
 // Preserve the old ownership to demonstrate the gesture bug before the fix.
 const legacy = new URLSearchParams(location.search).has('legacy');
 return h(AssistantRuntimeProvider,{runtime}, legacy
  ? h(ThreadPrimitive.Root,{className:'flex min-h-0 flex-1'},h(ThreadPrimitive.Viewport,{className:'codex-thread-viewport flex h-full flex-col overflow-y-auto px-4'},transcript,h(ThreadPrimitive.ViewportFooter,{className:'codex-composer-footer sticky bottom-0 mt-auto bg-background pb-3 pt-2'},footer)))
  : h(CodexThreadLayout,{footer},transcript));
}
function App() {
 const [machinesOpen,setMachinesOpen]=useState(false);
 const [section,setSection]=useState(settingsSectionFromHash);
 const [settings,setSettings]=useState(location.hash.startsWith('#settings'));
 useEffect(()=>{const changed=()=>{setSection(settingsSectionFromHash());setSettings(location.hash.startsWith('#settings'));};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[]);
 return h('div',{className:'app-frame','data-page':settings?'settings':'home','data-mobile-chat-open':String(!settings)},
   h('div',{className:'content-surface',style:{gridTemplateColumns:'minmax(0,1fr)'}},
     h('main',{className:'main-surface'},
       settings ? h(SettingsPage,{section,onSectionChange:navigateSettings,onBack:backToSettings,onClose:()=>{location.hash='home';}})
       : h('header',{className:'main-surface-header'},h('button',{onClick:()=>navigateSettings()},'Open Settings')),
       !settings && h('div',{className:'main-surface-content',style:{display:'flex',flexDirection:'column'}},h(Conversation)))),
   h('button',{className:'sr-only',onClick:()=>setMachinesOpen(true)},'Open machine dialog fixture'),
   h(ConnectionsDialog,{open:machinesOpen,onOpenChange:setMachinesOpen}));
}
createRoot(document.getElementById('root')).render(h(QueryClientProvider,{client},h(App)));
</script></body></html>`;

export async function startFixture(port = 0) {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { host: '127.0.0.1', port, strictPort: false, open: false },
    plugins: [{ name: 'mobile-ux-fixture', configureServer(vite) {
      vite.middlewares.use(async (req,res,next) => {
        if (req.url?.startsWith('/api/')) { res.setHeader('Content-Type','application/json'); res.end('[]'); return; }
        if (!req.url?.startsWith('/__mobile_ux__')) return next();
        try {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml(req.url,fixture));} catch(error){next(error);}
      });
    }}],
  });
  await server.listen();
  return {server,url:'http://127.0.0.1:'+server.httpServer.address().port+'/__mobile_ux__'};
}

const artifactDir = process.env.BOOSTED_BROWSER_ARTIFACTS ?? path.join(tmpdir(),'boosted-mobile-ux');
const browsers = new Map();
let server, url;
if (process.env.BOOSTED_UX_INTERACTIVE) {
 const result = await startFixture(5180);
 console.log(result.url);
} else {
 before(async()=>{({server,url}=await startFixture());await mkdir(artifactDir,{recursive:true});for(const [name,type] of Object.entries({chromium,webkit})) browsers.set(name,await type.launch());});
 after(async()=>{for(const browser of browsers.values()) await browser.close();await server?.close();});

 async function wheel(page, locator, delta) {
   await locator.hover();await page.mouse.wheel(0,delta);await page.waitForTimeout(300);
 }
 async function swipe(page, locator, delta, edge=false) {
   const b=await locator.boundingBox();const cdp=await page.context().newCDPSession(page);
   const x=b.x+(edge?2:b.width/2), y=b.y+b.height/2;
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+delta*i/8}]});await page.waitForTimeout(25);}
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(500);await cdp.detach();
 }
 const position=page=>page.evaluate(()=>({document:[scrollX,scrollY],transcript:document.querySelector('.codex-thread-viewport').scrollTop,footer:document.querySelector('.codex-composer-footer').getBoundingClientRect().toJSON(),root:document.querySelector('#root').getBoundingClientRect().toJSON()}));

 // The user's reference showed the former Settings drawer clipped left. Check
 // actual remaining Settings editors and the shared machine portal, not a mock.
 for (const engine of ['chromium','webkit']) {
   test(engine+' narrow Settings forms and machine dialog stay within viewport',async(t)=>{
     const context=await browsers.get(engine).newContext({viewport:{width:320,height:640},hasTouch:true});t.after(()=>context.close());
     const page=await context.newPage();
     const contained=async(selector,label)=>{
       const bounds=await page.locator(selector).evaluateAll(elements=>elements.map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width})));
       assert.ok(bounds.length,label+' exists');
       const width=page.viewportSize().width;
       for(const b of bounds) {assert.ok(b.width>0,label+' has width');assert.ok(b.left>=-1 && b.right<=width+1,label+' horizontally contained: '+JSON.stringify(b));}
       assert.equal(await page.evaluate(()=>scrollX),0,'no horizontal document pan');
     };
     for(const viewport of [{width:320,height:640},{width:393,height:852},{width:852,height:393},{width:1440,height:900}]) {
       await page.setViewportSize(viewport);await page.goto(url+'#settings');
       const nav=page.getByRole('navigation',{name:'Settings sections'});await nav.waitFor();
       await contained('.settings-page input, .settings-page nav button','category/search controls');
       assert.equal(await page.getByRole('dialog').count(),0,'Settings navigation has no drawer portal');
       await nav.getByRole('button',{name:'Connections',exact:true}).click();
       await page.getByRole('heading',{name:'Connections',exact:true,level:1}).waitFor();
       await page.getByRole('button',{name:'Add machine',exact:true}).click();
       await contained('.settings-machine-editor input, .settings-machine-editor button','inline machine controls');
       await page.getByRole('textbox',{name:'Machine name'}).fill('Viewport test');
       if(viewport.width<=900) {
         await page.evaluate(()=>window.keyboardGeometry(200,40));await page.waitForTimeout(100);
         await contained('.settings-machine-editor input, .settings-machine-editor button','keyboard inline controls');
         await page.getByRole('button',{name:'Cancel',exact:true}).click();
         await page.evaluate(h=>window.keyboardGeometry(h),viewport.height);await page.waitForTimeout(100);
       } else await page.getByRole('button',{name:'Cancel',exact:true}).click();
       // Only opens the isolated production dialog; no machine is saved/submitted.
       await page.getByRole('button',{name:'Open machine dialog fixture'}).evaluate(el=>el.click());
       const dialog=page.getByRole('dialog');await dialog.waitFor();
       await dialog.getByRole('button',{name:'Add machine',exact:true}).click();
       await contained('.connections-dialog, .connections-dialog input, .connections-dialog button','machine dialog/form/close/footer');
       await dialog.getByRole('textbox',{name:'Machine name'}).fill('Dialog test');
       if(viewport.width<=900) {
         await page.evaluate(()=>window.keyboardGeometry(200,40));await page.waitForTimeout(100);
         await contained('.connections-dialog, .connections-dialog input, .connections-dialog button','keyboard dialog controls');
         const b=await dialog.boundingBox();assert.ok(b.y>=40-1 && b.y+b.height<=240+1,'dialog fits simulated visual viewport');
         await dialog.getByRole('textbox',{name:'Password'}).fill('Disposable');
         await dialog.getByRole('button',{name:'Cancel',exact:true}).scrollIntoViewIfNeeded();
         assert.ok(await dialog.evaluate(el=>el.scrollTop)>0,'short dialog retains vertical scrolling');
         if(viewport.width===320) await page.screenshot({path:path.join(artifactDir,engine+'-machine-dialog-keyboard.png')});
       }
       await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
       await page.evaluate(h=>window.keyboardGeometry(h),viewport.height);await page.waitForTimeout(100);
     }
   });
 }

 test('legacy Codex layout reproduces transcript scrolling from composer surroundings',async(t)=>{
   const context=await browsers.get('chromium').newContext({viewport:{width:393,height:852},isMobile:true,hasTouch:true});t.after(()=>context.close());
   const page=await context.newPage();await page.goto(url+'?legacy=1');
   const transcript=page.locator('.codex-thread-viewport');await transcript.waitFor();
   await page.getByRole('textbox',{name:'Composer'}).fill('Draft');
   await page.evaluate(()=>window.keyboardGeometry(460));
   await page.waitForTimeout(100);
   await transcript.evaluate(el=>{el.scrollTop=el.scrollHeight;});
   const before=await transcript.evaluate(el=>el.scrollTop);
   await swipe(page,page.locator('.composer-surround'),60);
   assert.ok(await transcript.evaluate(el=>el.scrollTop)<before,'old composer drag scrolls transcript');
   console.log('Legacy composer drag transcript scroll:',before,'->',await transcript.evaluate(el=>el.scrollTop));
 });

 for(const engine of ['chromium','webkit']) for(const viewport of [{width:393,height:852},{width:1440,height:900}]) {
   test(engine+' '+viewport.width+'px: settings routes and independent chat scrolling',async(t)=>{
     const mobile=viewport.width<900;
     const context=await browsers.get(engine).newContext({viewport,isMobile:mobile&&engine==='chromium',hasTouch:mobile});t.after(()=>context.close());
     const page=await context.newPage();page.setDefaultTimeout(10000);
     const errors=[];page.on('pageerror',e=>errors.push(e.message));
     await page.goto(url);
     const transcript=page.locator('.codex-thread-viewport'),composer=page.getByRole('textbox',{name:'Composer'}),footer=page.locator('.codex-composer-footer');
     await composer.waitFor();
     assert.equal(await composer.evaluate(el=>!!el.closest('.codex-thread-viewport')),false);
     // Long thread supports ordinary wheel, keyboard navigation, and reading older messages.
     await transcript.evaluate(el=>{el.scrollTop=200;el.tabIndex=0;});
     await wheel(page,transcript,120);assert.ok(await transcript.evaluate(el=>el.scrollTop)>200);
     await transcript.focus();await transcript.press('PageUp');await page.waitForTimeout(300);
     await transcript.evaluate(el=>{el.scrollTop=200;});
     let before=await position(page);
     await wheel(page,page.locator('.composer-surround'),-120);assert.deepEqual(await position(page),before,'composer controls have no transcript/document scroll ownership');
     await composer.fill('Multiline draft\n'.repeat(40));
     await composer.press('Control+Home');await wheel(page,composer,100);
     assert.ok(await composer.evaluate(el=>el.scrollTop)>0,'multiline composer scrolls');
     assert.equal(await composer.evaluate(el=>getComputedStyle(el).touchAction),'auto');
     await composer.evaluate(el=>el.setSelectionRange(0,9));assert.equal(await composer.evaluate(el=>el.selectionEnd-el.selectionStart),9,'text selection retained');
     assert.equal(await composer.evaluate(el=>getComputedStyle(el).userSelect),'text');
     if(mobile){
       // Focus/blur plus VisualViewport events exercise actual production tracking.
       await composer.focus();await page.evaluate(()=>window.keyboardGeometry(460,40));await page.waitForTimeout(100);
       assert.equal(await page.locator('#root').evaluate(el=>el.getBoundingClientRect().height),460);
       assert.equal(await page.locator('#root').evaluate(el=>el.getBoundingClientRect().top),40);
       await transcript.evaluate(el=>{el.scrollTop=200;});before=await position(page);
       await wheel(page,page.locator('.composer-surround'),-100);assert.deepEqual(await position(page),before);
       if(engine==='chromium'){
         await swipe(page,footer,-70,true);await swipe(page,page.locator('.composer-surround'),70);assert.deepEqual(await position(page),before,'padding/control touch drags leave transcript and shell still');
         await swipe(page,transcript,-80);assert.ok(await transcript.evaluate(el=>el.scrollTop)>200,'message touch scroll retained');
       }
       await page.screenshot({path:path.join(artifactDir,engine+'-chat-keyboard.png')});
       await page.getByRole('button',{name:'Open Settings'}).focus();
       await page.evaluate(h=>window.keyboardGeometry(h),viewport.height);await page.waitForTimeout(100);
       assert.equal(await page.locator('html').getAttribute('data-keyboard-open'),null,'keyboard dismissal restores CSS');
       await page.setViewportSize({width:852,height:393});assert.equal(await page.locator('#root').evaluate(el=>el.getBoundingClientRect().height),393);
       await composer.focus();await page.evaluate(()=>window.keyboardGeometry(200));await page.waitForTimeout(100);
       const landscapeKeyboard=await position(page);
       assert.ok(landscapeKeyboard.footer.bottom<=landscapeKeyboard.root.bottom+1,'landscape keyboard keeps the entire composer visible');
       await wheel(page,composer,80);assert.ok(await composer.evaluate(el=>el.scrollTop)>0,'short landscape composer retains multiline scrolling');
       await page.getByRole('button',{name:'Open Settings'}).focus();await page.evaluate(()=>window.keyboardGeometry(393));
       await page.setViewportSize(viewport);
     }
     // Scroll-to-bottom still reaches the transcript through the shared provider.
     await transcript.evaluate(el=>{el.scrollTop=200;});await page.getByRole('button',{name:'Scroll to bottom'}).click();
     await page.waitForFunction(()=>{const el=document.querySelector('.codex-thread-viewport');return Math.abs(el.scrollHeight-el.scrollTop-el.clientHeight)<2;});
     await composer.fill('First line');await composer.press('Shift+Enter');await composer.type('Second');
     assert.match(await composer.inputValue(),/\n/);
     await page.getByRole('button',{name:'Send draft',exact:true}).click();assert.equal(await page.getByLabel('Sent drafts').textContent(),'1');
     await page.getByRole('button',{name:'Open Settings'}).click();
     const nav=page.getByRole('navigation',{name:'Settings sections'});
     await nav.waitFor();
     if(mobile){
       await page.getByRole('heading',{name:'Settings',exact:true,level:1}).waitFor();
       await page.screenshot({path:path.join(artifactDir,engine+'-settings-categories.png')});
       for(let repeat=0;repeat<2;repeat++){
         await nav.getByRole('button',{name:/Notifications/}).click();
         assert.ok((await page.url()).endsWith('#settings/notifications'));
         await page.getByRole('heading',{name:'Notifications',exact:true,level:1}).waitFor();
         assert.equal(await nav.count(),0);
         await page.screenshot({path:path.join(artifactDir,engine+'-settings-subpage.png')});
         await wheel(page,page.locator('.settings-main'),1000);
         assert.ok(await page.getByRole('button',{name:'Settings',exact:true}).isVisible(),'Back remains available in a long settings screen');
         await page.getByRole('button',{name:'Settings',exact:true}).click();await nav.waitFor();
         assert.ok((await page.url()).endsWith('#settings'));
         assert.equal(await nav.getByRole('button',{name:/Notifications/}).evaluate(el=>el===document.activeElement),true);
         await nav.getByRole('button',{name:/^Codex$/}).click();await page.getByRole('heading',{name:'Codex',exact:true,level:1}).waitFor();
         await page.goBack();await nav.waitFor();
         await page.goForward();await page.getByRole('heading',{name:'Codex',exact:true,level:1}).waitFor();
         await page.goBack();await nav.waitFor();
       }
       await page.setViewportSize({width:852,height:393});assert.equal(await page.locator('.settings-sidebar').count(),0);await nav.waitFor();
       await page.screenshot({path:path.join(artifactDir,engine+'-settings-landscape.png')});
       await page.setViewportSize(viewport);
       await page.getByRole('textbox',{name:'Search settings'}).fill('notifications');assert.equal(await nav.getByRole('button').count(),1);
       await page.getByRole('button',{name:'Clear settings search'}).click();
       await page.getByRole('button',{name:'Workspace',exact:true}).click();await composer.waitFor();
       // Direct subpage links get a safe category fallback for the in-app Back button.
       await page.goto(url+'#settings/codex');await page.getByRole('heading',{name:'Codex',exact:true,level:1}).waitFor();
       await page.getByRole('button',{name:'Settings',exact:true}).click();await nav.waitFor();
     }else{
       assert.equal(await page.locator('.settings-sidebar').count(),1);
       await nav.getByRole('button',{name:'Notifications',exact:true}).click();await page.getByRole('heading',{name:'Notifications',exact:true,level:1}).waitFor();
       await nav.getByRole('button',{name:'Codex',exact:true}).click();await page.getByRole('heading',{name:'Codex',exact:true,level:1}).waitFor();
       await page.goBack();await page.getByRole('heading',{name:'Notifications',exact:true,level:1}).waitFor();
       await page.waitForFunction(()=>document.querySelector('.settings-nav-item[aria-current=\"page\"]')?.textContent==='Notifications');
       assert.notEqual(await nav.getByRole('button',{name:'Notifications',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
       await page.getByRole('heading',{name:'Notifications',exact:true,level:1}).hover();
       await page.screenshot({path:path.join(artifactDir,engine+'-settings-desktop.png')});
       await page.getByRole('button',{name:'Back to workspace'}).click();await composer.waitFor();
     }
     assert.deepEqual(errors,[]);
   });
 }
}
