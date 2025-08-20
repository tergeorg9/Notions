# Notion → Static Site (CI/CD to GitHub Pages)

This repo turns a **public Notion space** into a **static site** using Playwright and deploys it to GitHub Pages via GitHub Actions.

## Quick start
1. Install deps locally:
   ```bash
   npm ci
   npx playwright install chromium
   ```
2. Run local crawl:
   ```bash
   START_URL="https://uxuitereshkin.notion.site/e5e41687f6254b4ebc2fa8a225732db4" npm run crawl
   ```
3. Serve locally:
   ```bash
   npm run serve
   ```

## CI setup
1. Push this repo to GitHub (main branch).
2. In **Settings → Secrets and variables → Variables**, add:
   - `NOTION_START_URL` = your public Notion root page.
3. Push to `main`. The workflow will:
   - Crawl Notion → `./site`
   - Deploy **GitHub Pages**. First deploy will auto-create Pages.

## Notes
- Only public pages under the same Notion host are crawled.
- Internal links are rewritten to local `.html`.
- Images are downloaded to `site/assets`.
- Basic JS keeps disclosure/accordion toggles working.
