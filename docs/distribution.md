# Building a Windows Distribution Package

How to build BPDF Reader into a real installer (`setup.exe`) and a portable
`.exe`, get it recognized by Windows as a PDF handler, and set it as the
default PDF viewer. Written 2026-08-30, when the app was renamed to BPDF
Reader and a real icon was added.

## Quick start

```bash
npm install
npm run dist          # setup.exe (NSIS installer) + a portable .exe, in dist/
```

`npm run dist:dir` builds an **unpacked** folder (`dist/win-unpacked/`)
instead — much faster, useful for checking the icon/name/build actually
worked before producing the full installer.

Both `predist`/`predist:dir` hooks run `scripts/copy-pdfjs.js` first (vendors
PDF.js/pdf-lib/docx/xlsx/jszip into `src/renderer/vendor/` — see that
script's own comment) — `npm run dist` always ships current source, you
don't need to run it separately.

## What you get

- **`dist/BPDF Reader Setup <version>.exe`** — the NSIS installer most users
  want. Per-user install (no admin/UAC prompt), lets the user pick the
  install directory (`nsis.oneClick: false` /
  `allowToChangeInstallationDirectory: true` in `package.json` → `build`),
  and registers a `.pdf` file association (see below).
- **`dist/BPDF Reader <version>.exe`** — a portable single-file build. No
  install, no file association, no Start Menu entry — just runs. Good for a
  USB stick or a locked-down machine, bad for "set as my default PDF app"
  (nothing to point Windows at afterward).

## Becoming the default PDF viewer

`package.json` → `build.fileAssociations` already declares `.pdf` with
`role: "Viewer"`. This makes the NSIS installer register BPDF Reader as **a**
valid handler for `.pdf` — it'll appear in *Open With* and in the *Default
Apps* picker.

**It cannot make itself the default automatically.** Since Windows 8, no
installer is allowed to silently change a file-type default — only the user
can, through Windows' own UI. This is intentional OS policy (originally an
antitrust settlement term, still enforced in 10/11), not a gap in this
app's setup — there is no config flag that gets around it. After installing,
the user needs to do one of:

- **Settings → Apps → Default apps** → search "BPDF Reader" → set it for
  `.pdf`, **or**
- **Settings → Apps → Default apps** → scroll to `.pdf` under "file type
  associations" → choose BPDF Reader, **or**
- Right-click any `.pdf` → **Open with → Choose another app** → pick
  **BPDF Reader** → check **"Always use this app to open .pdf files"**.

Once set, double-clicking any `.pdf`, or "Open with → BPDF Reader" without
the checkbox, launches this app. The existing single-instance lock
(`app.requestSingleInstanceLock()` in `main.js`) means opening a second PDF
while the app is already running focuses the existing window and loads into
it, rather than spawning a second instance.

## Code signing (you probably don't have this yet — that's fine)

The installer above is **unsigned**. On first run, Windows SmartScreen will
show *"Windows protected your PC"*; the user has to click **More info → Run
anyway**. This is normal for an unsigned indie/personal build and doesn't
mean anything is broken — but it does look alarming to a first-time user, so
mention it if you're handing the installer to someone else.

Getting rid of that warning means buying a code-signing certificate from a
CA (e.g. DigiCert, Sectigo — typically $100–400/year, and now generally
requires an EV-hardware-token or cloud-HSM-backed cert for immediate
SmartScreen reputation, per current CA/Browser Forum rules) and configuring
`build.win.certificateFile`/`certificatePassword` (or signing via a cloud
HSM's electron-builder plugin) — out of scope here since it needs an actual
purchased identity-verified certificate I can't provision. Worth doing if
this ships beyond your own machine and a few friends; skippable otherwise.

## The icon

`assets/icon.ico` (multi-resolution: 256/128/64/48/32/16px) is the Windows
icon, referenced by `build.win.icon`. `assets/icon.png` (1024×1024) is the
same design as a flat PNG (useful if you ever add a macOS/Linux target,
which need `.icns`/`.png` respectively — not currently configured, this repo
is Windows-only for now). Both are generated from `assets/icon.svg` — edit
that and run:

```bash
npm run build-icon
```

`scripts/build-icon.js` rasterizes the SVG through an offscreen Electron
window (Chromium's own renderer — same fonts/anti-aliasing the app itself
would use) at each required size, then packs the Windows sizes into one
`.ico` via `png-to-ico`. No ImageMagick or other external tool needed.

`main.js` also passes `icon: assets/icon.ico` to the `BrowserWindow`
constructor directly — this only matters for `npm start` (unpackaged dev
mode has no .exe to carry an embedded icon resource); the packaged
installer's taskbar/Start Menu/file-explorer icon comes from
`build.win.icon` being baked into the built `.exe` itself, same as any
other Windows executable.

## Testing a build before you trust it

1. `npm run dist:dir`, then run `dist/win-unpacked/BPDF Reader.exe` directly
   — confirms the app launches, title bar/taskbar/Alt-Tab all show "BPDF
   Reader" and the new icon, before spending time on the full installer.
2. `npm run dist`, run the resulting `Setup <version>.exe` on a real Windows
   machine (a VM is fine) — click through More info → Run anyway if
   SmartScreen appears (see above).
3. After installing: Settings → Default apps → set BPDF Reader for `.pdf`
   (see above), then double-click any `.pdf` file and confirm it opens in
   BPDF Reader.
4. Right-click a `.pdf` → **Open with** → confirm **BPDF Reader** appears in
   the list even before it's the default (this is the file-association
   registration working independently of default-app status).
5. Uninstall via **Settings → Apps** and confirm it's listed as "BPDF
   Reader" there too (comes from `productName`/`shortcutName`).

## Not set up (yet)

- **Auto-update** — `electron-updater` isn't wired in; installing a new
  version means re-running the installer over the old one (NSIS handles
  the upgrade in-place fine, just not automatically prompted).
- **macOS / Linux packaging** — only `build.win` is configured. Adding
  `build.mac`/`build.linux` targets is straightforward with electron-builder
  if this ever needs to ship cross-platform, but wasn't asked for here.
- **Code signing** — see above.
