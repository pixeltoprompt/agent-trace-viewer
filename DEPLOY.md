# Deploy to Vercel

Nothing to configure — Vercel auto-detects Vite, builds with `npm run build`, and serves
`dist/`. No environment variables, no serverless functions, no API keys: the sample traces
are bundled into the JS at build time.

## Option A — GitHub (recommended, gives you the repo link too)

```bash
git init
git add .
git commit -m "Agent Trace Viewer"
gh repo create agent-trace-viewer --public --source=. --push
```

Then on vercel.com: **Add New → Project → Import** the repo → **Deploy**. Framework preset
should already read "Vite". Every push to `main` redeploys.

## Option B — CLI, no GitHub

```bash
npm i -g vercel
vercel --prod
```

Accept the defaults; it detects Vite on its own.

## Checks before you ship

- `npm run build` succeeds locally (it does — verified).
- The three bundled traces appear in the picker on the deployed URL.
- Put the live link at the very top of the README, above the GIF.

## If the build fails on Vercel but works locally

Almost always a case-sensitivity issue: macOS and Windows filesystems ignore case, Vercel's
Linux builders don't. Check that every import matches the file name exactly —
`./components/GraphCanvas` not `./components/graphCanvas`.
