// Regenerates assets/icon.png (1024×1024) and assets/icon.ico (multi-
// resolution) from assets/icon.svg. Run with `npm run build-icon` after
// editing the SVG.
//
// Rasterizing runs through an actual Chromium window (via Electron, already
// a devDependency) rather than a canvas/SVG library, since it's the one
// renderer guaranteed to match what the app itself would draw (same fonts,
// same anti-aliasing) and needs no extra native deps beyond
// `png-to-ico` for the final multi-size .ico container.
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'assets', 'icon.svg');
const PNG_PATH = path.join(ROOT, 'assets', 'icon.png');
const ICO_PATH = path.join(ROOT, 'assets', 'icon.ico');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

async function rasterize(win, svgDataUrl, size) {
  const dataUrl = await win.webContents.executeJavaScript(`
    (function () {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = ${size};
          canvas.height = ${size};
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => reject(new Error('failed to load icon.svg'));
        img.src = ${JSON.stringify(svgDataUrl)};
      });
    })();
  `);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(SVG_PATH, 'utf8');
    const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;

    const win = new BrowserWindow({ width: 400, height: 300, show: false });
    await win.loadURL('about:blank');

    const png1024 = await rasterize(win, svgDataUrl, 1024);
    fs.writeFileSync(PNG_PATH, png1024);
    console.log('wrote', path.relative(ROOT, PNG_PATH));

    const icoBuffers = [];
    for (const size of ICO_SIZES) icoBuffers.push(await rasterize(win, svgDataUrl, size));

    const pngToIco = (await import('png-to-ico')).default;
    const ico = await pngToIco(icoBuffers);
    fs.writeFileSync(ICO_PATH, ico);
    console.log('wrote', path.relative(ROOT, ICO_PATH));
  } catch (err) {
    console.error('Icon build failed:', err.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
