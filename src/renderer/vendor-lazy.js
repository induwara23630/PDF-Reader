// Heavy vendor bundles, pulled in on demand instead of at every tab's boot.
//
// pdf-lib (~500 KB parsed) and JSZip (~360 KB) are only ever needed for
// Create PDF, Export, Organize Pages, or saving an annotated copy — none of
// which happen just from opening and reading a document. Deferring them keeps
// each tab's renderer lighter, which matters once many tabs are open.
//
// Each loader memoises its promise, so the bundle is parsed at most once per
// tab and concurrent callers share the one load.

let pdfLibPromise = null;

/** @returns {Promise<typeof import('./vendor/pdf-lib.esm.js')>} */
export function loadPdfLib() {
  if (!pdfLibPromise) pdfLibPromise = import('./vendor/pdf-lib.esm.js');
  return pdfLibPromise;
}

let jsZipPromise = null;

/** JSZip ships only a UMD build (no ESM), so it's injected as a classic
 *  <script> and read back off `window.JSZip`. @returns {Promise<any>} */
export function loadJSZip() {
  if (!jsZipPromise) {
    jsZipPromise = new Promise((resolve, reject) => {
      if (window.JSZip) return resolve(window.JSZip);
      const s = document.createElement('script');
      s.src = './vendor/jszip.js';
      s.onload = () =>
        window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip loaded but window.JSZip is missing'));
      s.onerror = () => reject(new Error('Could not load JSZip'));
      document.head.appendChild(s);
    });
  }
  return jsZipPromise;
}
