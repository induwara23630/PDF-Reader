// Copies the PDF.js ESM build + worker out of node_modules into
// src/renderer/vendor/ so the renderer can import them with a stable
// relative path that also survives packaging into an asar archive.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
const outDir = path.join(root, 'src', 'renderer', 'vendor');

const files = ['pdf.mjs', 'pdf.worker.mjs'];

// pdfjs-dist ships fonts/cmaps referenced at runtime for some documents.
const assetDirs = [
  ['node_modules/pdfjs-dist/cmaps', 'src/renderer/vendor/cmaps'],
  ['node_modules/pdfjs-dist/standard_fonts', 'src/renderer/vendor/standard_fonts'],
];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

try {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const from = path.join(srcDir, f);
    const to = path.join(outDir, f);
    fs.copyFileSync(from, to);
    console.log(`copied ${f}`);
  }
  for (const [from, to] of assetDirs) {
    const absFrom = path.join(root, from);
    const absTo = path.join(root, to);
    if (fs.existsSync(absFrom)) {
      copyDir(absFrom, absTo);
      console.log(`copied ${path.basename(from)}/`);
    }
  }
} catch (err) {
  console.error('Failed to copy pdfjs-dist assets:', err.message);
  console.error('Run "npm install" first.');
  process.exit(1);
}
