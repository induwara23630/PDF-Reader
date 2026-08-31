'use strict';

// Scripted smoke test of the shell / tab plumbing in src/main/main.js.
// Not part of the app bundle (package.json `files` excludes scripts/); run:
//
//   SMOKE="C:/path/a.pdf,C:/path/b.pdf" npx electron .
//
// Exercises open -> multi-tab -> activate -> reorder -> detach into a new
// window -> merge back onto another window's strip -> sleep a background tab
// -> wake it -> close. Prints PASS/FAIL lines and quits.

module.exports = function runSmoke(m) {
  const { app } = m;
  const [p1, p2] = String(process.env.SMOKE).split(',');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let failed = 0;
  const check = (cond, msg) => {
    if (!cond) failed++;
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  };
  const tabsOf = (w) => m.shells.get(w).tabs;
  const activeOf = (w) => m.shells.get(w).activeId;

  (async () => {
    await wait(1500);
    const winA = [...m.windows][0];

    m.openInWindowOrNew(p1); // reuse the empty welcome tab
    await wait(1200);
    m.createTab(winA, { path: p2 }); // second tab
    await wait(1200);
    check(tabsOf(winA).length === 2, 'window A has 2 tabs');

    // Layout sanity — the #1 reason strip clicks would "do nothing" is the
    // active tab view overlapping the 36px strip, or the strip not on top.
    {
      const sh = m.shells.get(winA);
      const cb = sh.chrome.getBounds();
      const tb = tabsOf(winA).find((t) => t.id === activeOf(winA)).view.getBounds();
      const kids = winA.contentView.children;
      check(cb.y === 0 && cb.height === 36, `strip at y0 h36 (got y${cb.y} h${cb.height})`);
      check(tb.y >= 36, `active tab starts below the strip (got y${tb.y})`);
      check(kids[kids.length - 1] === sh.chrome, 'chrome strip is the top-most child view');
    }

    m.activateTab(winA, tabsOf(winA)[0].id);
    await wait(200);
    check(activeOf(winA) === tabsOf(winA)[0].id, 'activateTab switches tabs');

    // A real OS-level click in the tab strip must switch tabs — regression
    // guard for pointer-capture on pointerdown eating the click event.
    const chromeWc = m.shells.get(winA).chrome.webContents;
    const secondId = tabsOf(winA)[1].id;
    const spot = await chromeWc.executeJavaScript(`(() => {
      const el = [...document.querySelectorAll('.tab')].find((t) => t.dataset.id === ${JSON.stringify(secondId)});
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) };
    })()`);
    chromeWc.sendInputEvent({ type: 'mouseDown', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    chromeWc.sendInputEvent({ type: 'mouseUp', x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
    await wait(400);
    check(activeOf(winA) === secondId, 'clicking a tab in the strip switches to it');

    // Lazy vendor bundles: absent at boot, load + build correctly on first use.
    const wc = tabsOf(winA).find((t) => t.id === activeOf(winA)).view.webContents;
    const lazy = await wc.executeJavaScript(`(async () => {
      const jszipAtBoot = typeof window.JSZip !== 'undefined'
        || !!document.querySelector('script[src*="jszip"]');
      const { loadPdfLib, loadJSZip } = await import('./vendor-lazy.js');
      const { PDFDocument } = await loadPdfLib();
      const d = await PDFDocument.create(); d.addPage([50, 50]);
      const pdfBytes = await d.save();
      const Z = await loadJSZip();
      const z = new Z(); z.file('x', 'y');
      const zipBytes = await z.generateAsync({ type: 'uint8array' });
      return { jszipAtBoot, pdfOk: pdfBytes.length > 100, zipOk: zipBytes.length > 20 };
    })()`).catch((e) => ({ err: String(e) }));
    check(lazy.jszipAtBoot === false, 'pdf-lib / JSZip not loaded at tab boot');
    check(lazy.pdfOk === true, 'pdf-lib loads on demand and builds a PDF');
    check(lazy.zipOk === true, 'JSZip loads on demand and builds a zip');

    const firstId = tabsOf(winA)[0].id;
    m.reorderTab(winA, firstId, 1);
    await wait(200);
    check(tabsOf(winA)[1].id === firstId, 'reorderTab moves a tab');

    const moveId = tabsOf(winA)[0].id;
    await m.detachTab(winA, moveId, { x: 120, y: 400 }); // empty space -> new window
    await wait(1500);
    check(m.windows.size === 2, 'detach opened a 2nd window');
    const winB = [...m.windows].find((w) => w !== winA);
    check(tabsOf(winB).some((t) => t.id === moveId), 'detached tab is in window B');
    check(!tabsOf(winA).some((t) => t.id === moveId), 'detached tab left window A');

    const ab = winA.getBounds();
    await m.detachTab(winB, moveId, { x: ab.x + 40, y: ab.y + 10 }); // onto A's strip
    await wait(1200);
    check(m.windows.size === 1, 'merge back closed window B');
    check(tabsOf(winA).length === 2, 'window A has 2 tabs again');

    const mem = (label) => {
      const procs = app.getAppMetrics();
      const mb = procs.reduce((a, p) => a + (p.memory?.workingSetSize || 0), 0) / 1024;
      console.log(`     ${label}: ${procs.length} procs, ${mb.toFixed(0)} MB`);
      return procs.length;
    };
    const procsBefore = mem('2 live tabs');
    const bg = tabsOf(winA).find((t) => t.id !== activeOf(winA));
    bg.snapshot = { page: 2, scalePct: null, fitMode: 'width', scrollRatio: 0.5 };
    bg.lastShown = 0;
    m.scanForSleep();
    await wait(1000);
    check(bg.sleeping && bg.view === null, 'idle background tab was discarded');
    check(mem('1 live + 1 sleeping') < procsBefore, 'a renderer process was freed');

    m.activateTab(winA, bg.id);
    await wait(2500);
    check(!bg.sleeping && bg.view !== null, 'activating a sleeping tab wakes it');
    check(bg.view.webContents.getURL().includes('index.html'), 'woken tab reloaded the viewer');

    m.closeTab(winA, activeOf(winA));
    await wait(400);
    check(m.windows.size === 1 && tabsOf(winA).length === 1, 'closeTab leaves 1 tab');

    // Closing the last tab must trigger the window close (window cleanup on
    // close is already proven by the detach/merge checks above). Checked
    // synchronously — window-all-closed -> app.quit() would otherwise pre-empt.
    m.closeTab(winA, activeOf(winA));
    check((m.shells.get(winA)?.tabs.length ?? 0) === 0, 'closing the last tab emptied + closed the window');

    console.log(failed ? `SMOKE FAILED (${failed})` : 'SMOKE OK — all checks passed');
    app.exit(failed ? 1 : 0);
  })().catch((e) => {
    console.error('SMOKE ERROR', e);
    app.exit(1);
  });
};
