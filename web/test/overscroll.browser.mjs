import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { createServer } from "vite";

// Install browsers once with `pnpm exec playwright install chromium webkit`.
// Use an ephemeral Vite server and isolated browser contexts, never the running app.
// This fixture exercises production CSS, ScrollArea, Dialog and viewport tracking
// without connecting to a machine or loading/changing any user data.
const fixture = `<!doctype html><html class="dark"><head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
</head><body><div class="ios-status-bar-background"></div><div id="root"></div>
<script type="module">
  import '/src/index.css';
  import '/src/app-shell.css';
  import '/src/components/settings.css';
  import { createElement as h } from 'react';
  import { createRoot } from 'react-dom/client';
  import { ScrollArea } from '/src/components/ui/scroll-area.tsx';
  import { Dialog, DialogContent, DialogTitle, DialogDescription } from '/src/components/ui/dialog.tsx';
  import { trackVisibleViewport } from '/src/lib/viewport.ts';
  window.stopTrackingViewport = trackVisibleViewport();
  const rows = (label) => Array.from({length: 80}, (_, i) => h('p', {key: i, style: {padding: '12px'}}, label + ' ' + i));
  const mobile = matchMedia('(max-width: 900px)').matches;
  const root = createRoot(document.getElementById('root'));
  window.renderFixture = (dialog = false) => root.render(h('div', {
    className: 'app-frame', 'data-page': 'chats', 'data-mobile-chat-open': String(mobile)
  },
    h('header', {className: 'shell-titlebar', hidden: mobile}, 'Boosted — scroll regression fixture'),
    h('div', {className: 'content-surface'},
      h('main', {className: 'main-surface'},
        h('header', {className: 'main-surface-header'},
          h('button', {onClick: () => window.renderFixture(true)}, 'Open dialog')),
        h('div', {className: 'main-surface-content panel-root'},
          h('div', {className: 'assistant-conversation-scroll min-h-0 flex-1 overflow-y-auto', tabIndex: 0}, rows('Message')),
          h(ScrollArea, {className: 'h-32 shrink-0 border-t'}, rows('File')),
          h('textarea', {className: 'shrink-0', 'aria-label': 'Composer', style: {height: '80px', overflow: 'auto'}, defaultValue: 'Draft\\n'.repeat(30)}))),
      h('aside', {className: 'right-navigation', hidden: mobile},
        h('div', {className: 'chat-list immersive-panel'},
          h('header', {className: 'chat-list-header'}, 'Chats'),
          h('div', {className: 'chat-list-scroll', tabIndex: 0}, rows('Conversation'))))),
    h('nav', {className: 'navigation-rail', hidden: mobile}, h('button', {className: 'destination', 'aria-label': 'Navigation'}, '+')),
    h(Dialog, {open: dialog, onOpenChange: window.renderFixture},
      h(DialogContent, null,
        h(DialogTitle, null, 'Scrollable dialog'),
        h(DialogDescription, null, 'Verify portal scrolling and input focus.'),
        ...rows('Setting'), h('input', {'aria-label': 'Dialog input'})))));
  window.renderFixture();
</script></body></html>`;

let server;
let url;
const browsers = new Map();
before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    plugins: [{
      name: "overscroll-fixture",
      configureServer(fixtureServer) {
        fixtureServer.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__overscroll_fixture__") return next();
          try {
            res.setHeader("Content-Type", "text/html");
            res.end(await fixtureServer.transformIndexHtml(req.url, fixture));
          } catch (error) {
            next(error);
          }
        });
      },
    }],
  });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/__overscroll_fixture__`;
  for (const [name, browserType] of Object.entries({ chromium, webkit })) {
    browsers.set(name, await browserType.launch());
  }
});
after(async () => {
  await Promise.all([...browsers.values()].map((browser) => browser.close()));
  await server?.close();
});

async function wheel(page, locator, x, y) {
  await locator.hover();
  await page.mouse.wheel(x, y);
  // Wheel dispatch returns before asynchronous scrolling and boundary effects end.
  await page.waitForTimeout(250);
}

async function shellBounds(page) {
  return page.evaluate(() => ({
    scroll: [scrollX, scrollY],
    root: document.querySelector('#root').getBoundingClientRect().toJSON(),
    frame: document.querySelector('.app-frame').getBoundingClientRect().toJSON(),
  }));
}

async function swipe(page, locator, deltaY) {
  const bounds = await locator.boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + deltaY * step / 8 }] });
    await page.waitForTimeout(25);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
  await session.detach();
}

for (const engine of ["chromium", "webkit"]) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 393, height: 852 }]) {
    test(`${engine} ${viewport.width}px: scroll boundaries, portals, inputs and viewport`, async (t) => {
      const mobile = viewport.width < 900;
      // Playwright cannot dispatch wheels in mobile WebKit. Check its responsive
      // layout at phone width with touch enabled; this is not real iOS Safari.
      const context = await browsers.get(engine).newContext({ viewport, isMobile: mobile && engine === "chromium", hasTouch: mobile });
      t.after(() => context.close());
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => { errors.push(error.message); t.diagnostic(error.message); });
      await page.route("**/api/**", (route) => route.abort());
      await page.goto(url);
      await page.locator(".assistant-conversation-scroll p").last().waitFor({ state: "attached" });
      assert.deepEqual(errors, []);

      const original = await shellBounds(page);
      assert.equal(original.root.height, viewport.height);
      assert.equal(original.frame.height, viewport.height);
      assert.equal(original.frame.width, viewport.width);
      for (const selector of ["html", "body", "#root", ".app-frame"]) {
        assert.equal(await page.locator(selector).evaluate((el) => getComputedStyle(el).overscrollBehavior), "none", selector);
      }
      await wheel(page, page.locator('.main-surface-header'), 500, 500);
      await wheel(page, page.locator('.main-surface-header'), -500, -500);
      assert.deepEqual(await shellBounds(page), original, 'outer chrome boundary gestures');

      const selectors = [".assistant-conversation-scroll", "[data-radix-scroll-area-viewport]", ...(mobile ? [] : [".chat-list-scroll"])];
      for (const selector of selectors) {
        const scroller = page.locator(selector);
        assert.equal(await scroller.evaluate((el) => getComputedStyle(el).overscrollBehavior), "contain", selector);
        await wheel(page, scroller, 0, 180);
        assert.ok(await scroller.evaluate((el) => el.scrollTop > 0), `${selector} scrolls normally`);
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await wheel(page, scroller, 240, 900);
        assert.deepEqual(await shellBounds(page), original, `${selector} bottom boundary`);
        await scroller.evaluate((el) => { el.scrollTop = 0; });
        await wheel(page, scroller, -240, -900);
        assert.deepEqual(await shellBounds(page), original, `${selector} top boundary`);
      }

      const conversation = page.locator(".assistant-conversation-scroll");
      await conversation.focus();
      await conversation.press("PageDown");
      await page.waitForFunction(() => document.querySelector('.assistant-conversation-scroll').scrollTop > 0);
      await conversation.evaluate((el) => { el.scrollTop = 0; });
      if (mobile && engine === "chromium") {
        // Native touch input, rather than synthetic DOM touchmove events.
        await swipe(page, conversation, -120);
        assert.ok(await conversation.evaluate((el) => el.scrollTop > 0), 'touch swipe scrolls conversation');
        await conversation.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await swipe(page, conversation, -120);
        assert.deepEqual(await shellBounds(page), original, 'touch bottom boundary');
        await conversation.evaluate((el) => { el.scrollTop = 0; });
        await swipe(page, conversation, 120);
        assert.deepEqual(await shellBounds(page), original, 'touch top boundary');
      }

      // Primary regions must stop chaining even with a genuinely scrollable ancestor.
      await conversation.evaluate((el) => {
        const parent = document.createElement('div');
        parent.id = 'scroll-parent';
        parent.style.cssText = 'height:160px;overflow:auto;flex:none';
        el.before(parent);
        parent.append(el);
        el.style.cssText = 'height:160px;flex:none';
        const spacer = document.createElement('div');
        spacer.style.height = '800px';
        parent.append(spacer);
        el.scrollTop = el.scrollHeight;
      });
      await wheel(page, conversation, 0, 500);
      assert.equal(await page.locator("#scroll-parent").evaluate((el) => el.scrollTop), 0, 'no chaining to ancestor');
      await conversation.evaluate((el) => {
        const parent = el.parentElement;
        parent.before(el);
        parent.remove();
        el.style.cssText = '';
        el.scrollTop = 0;
      });

      const composer = page.getByRole("textbox", { name: "Composer" });
      await composer.fill("Editable draft\n".repeat(40));
      await composer.press("Control+Home");
      await wheel(page, composer, 0, 100);
      assert.ok(await composer.evaluate((el) => el.scrollTop > 0), 'textarea still scrolls');
      assert.equal(await composer.evaluate((el) => getComputedStyle(el).touchAction), "auto");
      assert.match(await composer.inputValue(), /Editable draft/);

      await page.getByRole("button", { name: "Open dialog" }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await wheel(page, dialog, 0, 250);
      assert.ok(await dialog.evaluate((el) => el.scrollTop > 0), 'portal dialog scrolls');
      await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await wheel(page, dialog, 0, 900);
      assert.deepEqual(await shellBounds(page), original, 'dialog boundary leaves shell fixed');
      await page.getByRole("textbox", { name: "Dialog input" }).fill("Focused input");
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });

      if (mobile) {
        await page.setViewportSize({ width: 852, height: 393 });
        const landscape = await shellBounds(page);
        assert.equal(landscape.root.height, 393);
        assert.equal(landscape.frame.width, 852);
        assert.equal(landscape.frame.height, 393);
        await page.setViewportSize(viewport);
        assert.deepEqual(await shellBounds(page), original, 'portrait viewport restored');

        // Emulate a bottom safe-area inset without altering the device/browser env().
        await page.evaluate(() => document.documentElement.style.setProperty('--safe-area-bottom', '34px'));
        assert.deepEqual(await shellBounds(page), original, 'safe area stays inside shell');
        assert.equal(await page.locator('.app-frame').evaluate((el) => getComputedStyle(el).paddingBottom), '34px');
        await page.evaluate(() => document.documentElement.style.removeProperty('--safe-area-bottom'));

        // Exercise the existing CSS keyboard/pan contract. Keyboard detection logic,
        // dismissal, rotation and stale VisualViewport values have Vitest coverage.
        await page.evaluate(() => {
          window.stopTrackingViewport();
          document.documentElement.style.setProperty('--app-viewport-height', '460px');
          document.documentElement.style.setProperty('--app-viewport-top', '90px');
          document.documentElement.setAttribute('data-keyboard-open', '');
        });
        const keyboard = await shellBounds(page);
        assert.equal(keyboard.root.top, 90);
        assert.equal(keyboard.root.height, 460);
        assert.equal(keyboard.frame.height, 460);
        await page.evaluate(() => {
          document.documentElement.style.removeProperty('--app-viewport-height');
          document.documentElement.style.removeProperty('--app-viewport-top');
          document.documentElement.removeAttribute('data-keyboard-open');
        });
        assert.deepEqual(await shellBounds(page), original, 'resting viewport restored');
        await page.getByRole("button", { name: "Open dialog" }).tap();
        await dialog.waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }

      const artifactDir = process.env.BOOSTED_BROWSER_ARTIFACTS ?? path.join(tmpdir(), 'boosted-overscroll');
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({ path: path.join(artifactDir, `${engine}-${viewport.width}.png`) });
      assert.deepEqual(errors, []);
    });
  }
}
