# stuPad

Offline iPad PWA that turns a structured PowerPoint deck into a self-running, touch-driven kiosk, logs every interaction, and exports CSV and PDF reports.

- Spec: [docs/SPEC.md](docs/SPEC.md)
- Plan: [docs/PLAN.md](docs/PLAN.md)

```bash
npm install
npm run dev
```

## Deploying to GitHub Pages

Pushing to `main` runs `.github/workflows/deploy-pages.yml`, which tests, builds, and publishes to `https://grahamlehr.github.io/stuPad/`.

One-time setup: go to Settings → Pages → Build and deployment → Source and choose **GitHub Actions**. Then open the URL in Safari on the iPad, use Share → Add to Home Screen, and launch it once while online so it caches for offline use.
