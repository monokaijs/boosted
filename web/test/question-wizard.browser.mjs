import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

// Run: pnpm --filter @boosted/web exec node --test test/question-wizard.browser.mjs
// Install browsers once: pnpm --filter @boosted/web exec playwright install chromium webkit
// Render the real production form in its shell/footer placement, without user data.
const fixture = `<!doctype html><html class="dark"><head>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
</head><body><div id="root"></div><script type="module">
import '/src/index.css';
import '/src/app-shell.css';
import { createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { CodexQuestionForm } from '/src/components/assistant-ui/codex-question-form.tsx';
import { trackVisibleViewport } from '/src/lib/viewport.ts';
const root = createRoot(document.getElementById('root'));
const mobile = innerWidth <= 900;
window.attempts = 0;
window.payloads = [];
const questions = [
  {id:'scope', header:'Planning scope', question:'Which approach should this plan use?\\n\\n' + 'Consider the existing implementation and preserve user changes. '.repeat(16) + ' VeryLongReference'.repeat(30).replaceAll(' ', ''), options:Array.from({length:8}, (_,i) => ({label:i === 0 ? 'Minimal change (Recommended)' : 'Alternative ' + i, description:('Explain the tradeoff, requirements and affected behavior. ').repeat(8) + 'LongOptionReference'.repeat(20)}))},
  {id:'requirements', header:'Requirements', question:'What requirements should the plan preserve?'},
  {id:'verification', header:'Verification', question:'How should we verify it?', options:[{label:'Tests and browser checks',description:'Verify behavior and viewport sizing.'},{label:'Custom verification',description:'Write your own response below.'}]}
];
window.renderQuestions = (id = 'native-request', items = questions) => root.render(h('div', {className:'app-frame', 'data-page':'chats', 'data-mobile-chat-open':String(mobile)},
  h('header',{className:'shell-titlebar', hidden:mobile},'Boosted'),
  h('div',{className:'content-surface'},h('main',{className:'main-surface'},
    h('header',{className:'main-surface-header'},'Planning'),
    h('div',{className:'main-surface-content panel-root'},
      h('div',{className:'codex-thread-viewport relative flex h-full flex-col overflow-y-auto px-4'},
        h('p',{className:'py-6'},'I have a few questions before writing the plan.'),
        h('footer',{className:'codex-composer-footer sticky bottom-0 mt-auto'},
          h(CodexQuestionForm,{requestId:id,questions:items,onSubmit:async (answers) => {
            window.attempts++;
            await new Promise(resolve => setTimeout(resolve, 50));
            if(window.attempts === 1) throw new Error('Connection lost. Please retry. ' + 'LongServerError'.repeat(50));
            window.payloads.push({id, answers});
          }}),
          h(CodexQuestionForm,{requestId:'independent',questions:[{id:'scope',header:'Independent request',question:'An independent question?'}],onSubmit:async () => { throw new Error('Should not submit another request'); }}),
          h('textarea',{'aria-label':'Chat composer',className:'w-full mt-2',placeholder:'Message Codex…'}))))))));
window.renderQuestions();
let stop = trackVisibleViewport();
let mockViewport;
window.mockKeyboard = (height, offsetTop) => {
  if (!mockViewport) {
    stop();
    mockViewport = Object.assign(new EventTarget(),{height:innerHeight,width:innerWidth,offsetTop:0,scale:1});
    Object.defineProperty(window,'visualViewport',{configurable:true,value:mockViewport});
    stop = trackVisibleViewport();
  }
  Object.assign(mockViewport,{height,offsetTop});
  mockViewport.dispatchEvent(new Event('resize'));
};
</script></body></html>`;

let server;
let url;
let cacheDir;
const browsers = new Map();
before(async () => {
  // Isolate Vite's optimizer as well as its port: other chats/tests may use Vite.
  cacheDir = await mkdtemp(path.join(tmpdir(), "boosted-question-wizard-vite-"));
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    cacheDir,
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    plugins: [{ name: "question-wizard-fixture", configureServer(fixtureServer) {
      fixtureServer.middlewares.use(async (req, res, next) => {
        if (req.url !== "/__question_wizard__") return next();
        try {
          res.setHeader("Content-Type", "text/html");
          res.end(await fixtureServer.transformIndexHtml(req.url, fixture));
        } catch (error) { next(error); }
      });
    } }],
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/__question_wizard__`;
  for (const [name, browserType] of Object.entries({ chromium, webkit })) browsers.set(name, await browserType.launch());
});
after(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
  await server?.close();
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

const artifactDir = process.env.BOOSTED_BROWSER_ARTIFACTS ?? path.join(tmpdir(), "boosted-question-wizard");
async function screenshot(page, name) {
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
}
async function checkBounds(page, top = 0, height) {
  const result = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    const dialog = document.querySelector('.question-wizard-dialog');
    const body = document.querySelector('.question-wizard-body');
    return {dialog:box('.question-wizard-dialog'),footer:box('.question-wizard-footer'),body:box('.question-wizard-body'),
      dialogWidths:[dialog.clientWidth,dialog.scrollWidth],bodyWidths:[body.clientWidth,body.scrollWidth],scroll:[scrollX,scrollY]};
  });
  const viewport = page.viewportSize();
  assert.ok(result.dialog.top >= top, JSON.stringify(result));
  assert.ok(result.dialog.bottom <= top + (height ?? viewport.height), JSON.stringify(result));
  assert.ok(result.dialog.left >= 0 && result.dialog.right <= viewport.width, JSON.stringify(result));
  assert.ok(result.footer.top >= result.dialog.top && result.footer.bottom <= result.dialog.bottom, JSON.stringify(result));
  assert.ok(result.body.height > 0, "question body has available space");
  assert.ok(result.dialogWidths[1] <= result.dialogWidths[0] + 1, "no horizontal dialog overflow");
  assert.ok(result.bodyWidths[1] <= result.bodyWidths[0] + 1, "no horizontal question overflow");
  assert.deepEqual(result.scroll, [0, 0], "document stays fixed");
}

for (const engine of ["chromium", "webkit"]) {
  for (const viewport of [{width:1440,height:900}, {width:1440,height:240}, {width:393,height:852}, {width:320,height:568}, {width:852,height:320}]) {
    test(`${engine} ${viewport.width}x${viewport.height}: real question wizard`, async (t) => {
      const mobile = viewport.width <= 900;
      // Mobile WebKit has no wheel API in Playwright; use phone-sized desktop mode.
      const context = await browsers.get(engine).newContext({viewport,isMobile:mobile && engine === "chromium",hasTouch:mobile});
      t.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", error => { errors.push(error.message); t.diagnostic(error.message); });
      await page.route("**/api/**", route => route.abort());
      await page.goto(url);
      const launch = page.getByRole("button", {name:"Answer questions"});
      await launch.click();
      await checkBounds(page);
      assert.equal(await page.locator('legend').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.locator('.question-wizard-dialog').evaluate(el => el.contains(document.activeElement)), true, 'focus stays in the dialog');
      assert.equal(await page.getByRole("button",{name:"Next"}).isDisabled(), true);
      assert.equal(await page.getByRole("button",{name:"Back"}).isDisabled(), true);
      assert.equal(await page.getByRole("button",{name:"Send answers"}).count(), 0);
      assert.equal(await page.locator('.question-wizard-fields').count(), 1);
      assert.equal(await page.getByRole('radio').evaluateAll(els => els.every(el => !el.checked)), true);
      await screenshot(page, `${engine}-${viewport.width}x${viewport.height}-long-question`);

      const body = page.locator('.question-wizard-body');
      const footer = await page.locator('.question-wizard-footer').boundingBox();
      await body.hover(); await page.mouse.wheel(0,500); await page.waitForTimeout(200);
      assert.ok(await body.evaluate(el => el.scrollTop > 0), 'long content scrolls');
      assert.deepEqual(await page.locator('.question-wizard-footer').boundingBox(),footer,'navigation does not scroll away');
      await page.getByRole('radio',{name:'Minimal change (Recommended)'}).check();
      await screenshot(page, `${engine}-${viewport.width}x${viewport.height}-long-options`);
      await page.getByRole('button',{name:'Next'}).click();
      assert.equal(await page.getByText('Question 2/3').count(),1);
      await checkBounds(page);
      assert.equal(await body.evaluate(el => el.scrollTop),0,'next question starts at top');
      const answer = page.getByRole('textbox',{name:'Answer: What requirements should the plan preserve?'});
      await answer.fill('Custom requirements');
      await page.getByRole('button',{name:'Back'}).click();
      assert.equal(await page.getByRole('radio',{name:'Minimal change (Recommended)'}).isChecked(),true);
      await page.getByRole('button',{name:'Next'}).click();
      assert.equal(await answer.inputValue(),'Custom requirements');

      if (mobile) {
        await answer.focus();
        await page.evaluate(() => window.mockKeyboard(220,40));
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-viewport-height') === '220px');
        await checkBounds(page,40,220);
        await screenshot(page,`${engine}-${viewport.width}x${viewport.height}-keyboard`);
        assert.equal(await page.getByRole('button',{name:'Next'}).isVisible(),true);
        // A landscape keyboard can leave substantially less height than portrait.
        await page.evaluate(() => window.mockKeyboard(150,40));
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--app-viewport-height') === '150px');
        await checkBounds(page,40,150);
        await page.evaluate(height => window.mockKeyboard(height,0), viewport.height);
        await page.waitForFunction(() => !document.documentElement.hasAttribute('data-keyboard-open'));
      }

      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({state:'detached'});
      await page.waitForFunction(() => document.activeElement?.textContent === 'Continue answers');
      await page.getByRole('button',{name:'Continue answers'}).click();
      assert.equal(await answer.inputValue(),'Custom requirements');
      await page.getByRole('button',{name:'Next'}).click();
      await page.getByRole('radio',{name:'Tests and browser checks'}).check();
      assert.equal(await page.evaluate(() => window.attempts),0,'no submission before the final stage');
      // Repeated form events in one browser task must produce one attempt.
      await page.getByRole('form').evaluate(form => {
        for (let i=0;i<3;i++) form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      });
      await page.getByRole('alert').waitFor();
      assert.equal(await page.evaluate(() => window.attempts),1);
      await checkBounds(page);
      await screenshot(page,`${engine}-${viewport.width}x${viewport.height}-error`);
      await page.getByRole('button',{name:'Back'}).click();
      assert.equal(await answer.inputValue(),'Custom requirements');
      await page.getByRole('button',{name:'Next'}).click();
      await page.getByRole('button',{name:'Send answers'}).click();
      await page.getByText('Answers sent to Codex.').waitFor();
      assert.equal(await page.evaluate(() => window.attempts),2);
      assert.deepEqual(await page.evaluate(() => window.payloads),[{id:'native-request',answers:{scope:{answers:['Minimal change (Recommended)']},requirements:{answers:['Custom requirements']},verification:{answers:['Tests and browser checks']}}}]);
      await page.getByRole('dialog').waitFor({state:'detached'});

      // Same question ids in an independent request must not inherit these answers.
      await page.getByRole('button',{name:'Answer question'}).click();
      assert.equal(await page.getByRole('textbox',{name:'Answer: An independent question?'}).inputValue(),'');
      assert.equal(await page.getByRole('button',{name:'Next'}).count(),0);
      assert.equal(await page.getByRole('button',{name:'Back'}).count(),0);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({state:'detached'});
      // A newly rendered request resets the sent state even if all question ids match.
      await page.evaluate(() => window.renderQuestions('replacement'));
      await page.getByRole('button',{name:'Answer questions'}).click();
      assert.equal(await page.getByText('Question 1/3').count(),1);
      assert.equal(await page.getByRole('radio').evaluateAll(els => els.every(el => !el.checked)),true);
      assert.deepEqual(errors,[]);
    });
  }
}
