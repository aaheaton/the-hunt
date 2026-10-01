# Hosting The Hunt on GitHub Pages

The app is a static PWA (plain HTML/CSS/JS, ~400 KB, no build step), so GitHub
Pages can host it for free with a permanent `https://` URL — which is what
phones need for GPS, compass and camera access.

All paths in the app are relative (`./index.html`, `css/…`, `js/…`), so it works
as-is under a Pages sub-path like `https://<username>.github.io/the-hunt/`.
Nothing needs changing before you upload.

---

## 1. Create the repository

1. Sign in at <https://github.com> (create a free account if needed).
2. Click **+** (top right) → **New repository**.
3. Name it `the-hunt` (this becomes part of the URL).
4. Choose **Public** — GitHub Pages on a free account requires a public repo.
   (Private repos need GitHub Pro.)
5. Leave "Add a README" **unticked**, then click **Create repository**.

## 2. Upload the files — pick ONE option

### Option A — Browser upload (no tools needed, easiest)

1. On the new empty repo page, click **uploading an existing file**.
2. Open `C:\Users\aahea\OneDrive\Downloads\Hunt_C\the-hunt-pwa` in File Explorer.
3. Select **everything inside** that folder (`index.html`, `manifest.json`,
   `sw.js`, `README.md`, and the `css`, `js`, `icons`, `assets`, `data`
   folders) and drag it onto the GitHub page.
   - Drag the *contents*, not the `the-hunt-pwa` folder itself — `index.html`
     must end up at the top level of the repo.
   - Empty folders (e.g. `data`) are skipped by GitHub; that's fine.
4. Write a message like "Initial upload" and click **Commit changes**.

### Option B — Git command line

Install Git for Windows (<https://git-scm.com/download/win>) if you don't have
it, then in a terminal:

```bash
cd "C:\Users\aahea\OneDrive\Downloads\Hunt_C\the-hunt-pwa"
git init
git add .
git commit -m "Initial upload"
git branch -M main
git remote add origin https://github.com/<username>/the-hunt.git
git push -u origin main
```

The first push opens a browser window to sign in to GitHub.

## 3. Turn on GitHub Pages

1. In the repo, go to **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)** → **Save**.
4. Wait 1–2 minutes, refresh the page. A banner appears:
   **"Your site is live at https://<username>.github.io/the-hunt/"**.
   (Progress is visible under the repo's **Actions** tab.)

## 4. Open it on your phone

1. Open `https://<username>.github.io/the-hunt/` in Chrome (Android) or
   Safari (iPhone).
2. Tap **Start Hunting** and allow **location**, **motion/orientation** (iOS
   asks separately) and **camera** when prompted.
3. Install it as an app:
   - **Android / Chrome:** ⋮ menu → **Add to Home screen** / **Install app**.
   - **iPhone / Safari:** Share button → **Add to Home Screen**.

---

## Updating the app later

Every change you push (or upload) redeploys automatically within a minute or two.

- **Browser:** in the repo, **Add file → Upload files**, drag the changed files
  in (same folder structure), commit. Uploading a file with the same name
  replaces it.
- **Git:** `git add . && git commit -m "describe change" && git push`

**Important — bump the cache version.** The service worker caches the app
shell. When you change files, open `sw.js` and bump the version, e.g.
`const CACHE_NAME = 'the-hunt-v3';` → `'the-hunt-v4';` — and if you add new
files (e.g. new creature art), add them to the `APP_SHELL` list too.
Otherwise installed copies on phones can keep serving old files.
If a phone still shows the old version: close the app fully and reopen it
(or in Chrome, clear site data for the github.io address).

## Troubleshooting

| Problem | Fix |
|---|---|
| 404 at the Pages URL | Check `index.html` is at the repo root (not inside a `the-hunt-pwa/` subfolder). Wait a couple of minutes after enabling Pages. |
| Page loads but no styling / blank | A folder was missed in the upload — check `css/`, `js/`, `icons/`, `assets/` all exist in the repo. Folder names are case-sensitive on GitHub. |
| Location / camera never prompts | Make sure you're on the `https://` URL. On iPhone, check Settings → Safari → Location / Camera / Motion & Orientation Access. |
| Compass doesn't move on iPhone | iOS only grants orientation after a tap — use the **Start Hunting** button rather than reloading straight into a tab. |
| Old version keeps showing | Bump `CACHE_NAME` in `sw.js` (see above) and reopen the app. |

## Notes

- The repo is public, so the code and creature art are visible to anyone who
  finds it. Players' collections stay in their own browser (`localStorage`) —
  nothing is uploaded.
- Optional custom domain: Settings → Pages → **Custom domain** (needs a domain
  you own plus a DNS record — GitHub shows the exact records to add).
