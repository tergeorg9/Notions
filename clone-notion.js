#!/usr/bin/env node
/**
 * Notion → Static Site Cloner
 * ---------------------------------
 * Usage:
 *   1) node clone-notion.js "https://uxuitereshkin.notion.site/e5e41687f6254b4ebc2fa8a225732db4"
 *   2) The script will create ./site with HTML pages + ./site/assets for images.
 *   3) Serve locally: npx http-server ./site  (or any static server)
 *
 * Requirements:
 *   - Node 18+
 *   - npm i playwright@^1  node-html-parser@^6  slugify@^1  axios@^1  mkdirp@^3
 *     (Playwright will prompt to install browsers: npx playwright install chromium)
 *
 * What it does:
 *   - Crawls the public Notion site starting from the given URL (same domain only)
 *   - Renders with Chromium (so dynamic content loads)
 *   - Saves clean static HTML per page (images downloaded to ./site/assets)
 *   - Rewrites internal links to relative .html files
 *   - Adds tiny JS to keep disclosure/accordion toggles working
 *
 * Notes:
 *   - Only pages under the same host are cloned (e.g., uxuitereshkin.notion.site)
 *   - If a page requires login, it will be skipped
 *   - You can increase MAX_PAGES or tweak WAIT_SELECTOR if needed
 */

import { chromium } from 'playwright';
import { parse } from 'node-html-parser';
import slugify from 'slugify';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirp } from 'mkdirp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const START_URL = process.argv[2];
if (!START_URL) {
  console.error('✖ Please provide a public Notion URL.\\n   Example: node clone-notion.js "https://your.notion.site/xxxxxxxxxxxxxxxxxxxx"');
  process.exit(1);
}

const OUTPUT_DIR = path.join(__dirname, 'site');
const ASSETS_DIR = path.join(OUTPUT_DIR, 'assets');
const MAX_PAGES = 150; // safety cap
const WAIT_SELECTOR = '.notion-page-content, main, body';

const visited = new Map(); // url -> {title, filename}
const queue = [normalizeUrl(START_URL)];
let host;

try {
  host = new URL(START_URL).host;
} catch (e) {
  console.error('Invalid URL:', START_URL);
  process.exit(1);
}

await mkdirp(OUTPUT_DIR);
await mkdirp(ASSETS_DIR);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });

console.log('🚀 Starting crawl at', START_URL);

while (queue.length && visited.size < MAX_PAGES) {
  const url = queue.shift();
  if (visited.has(url)) continue;

  const page = await context.newPage();
  console.log('→ Visiting', url);

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!resp || !resp.ok()) {
      console.warn('  ! Skipped (status):', resp ? resp.status() : 'no response');
      await page.close();
      continue;
    }

    // Wait for content holder
    await page.waitForSelector(WAIT_SELECTOR, { timeout: 35000 }).catch(() => {});

    // Expand any lazy toggles if possible (click all buttons that look like toggles)
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      buttons.forEach((btn) => {
        const hasIcon = btn.querySelector('svg') || btn.querySelector('img');
        const isToggleLike = btn.getAttribute('aria-expanded') !== null || btn.getAttribute('aria-controls');
        if (isToggleLike && hasIcon && (btn.textContent || '').trim().length < 300) {
          try { btn.click(); } catch {}
        }
      });
    });

    // Get the full HTML after render
    const html = await page.content();
    const root = parse(html);

    // Determine a sensible title
    let title = root.querySelector('title')?.text?.trim() || 'page';
    title = title.replace(/ – Notion$/, '').trim() || 'page';

    const slug = uniqueSlug(title, visited);
    const filename = `${slug}.html`;

    // Collect and download images
    const images = new Set(
      root.querySelectorAll('img').map((img) => img.getAttribute('src')).filter(Boolean)
    );

    const urlObj = new URL(url);

    // Rewrite internal links and build crawl queue
    root.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      try {
        const abs = new URL(href, urlObj).toString();
        const nh = normalizeUrl(abs);
        const sameHost = new URL(abs).host === host;
        if (sameHost && isNotionPage(abs)) {
          // map to local file
          let mapped = visited.get(nh)?.filename;
          if (!mapped) {
            const guess = `${slugify((a.text || 'page').trim() || 'page', { lower: true, strict: true }).slice(0,60) || 'page'}`;
            mapped = `${guess || 'page'}.html`;
          }
          a.setAttribute('href', mapped);
          if (!visited.has(nh) && !queue.includes(nh)) queue.push(nh);
        } else {
          // keep external links as-is
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
        }
      } catch {}
    });

    // Minimal CSS to make standalone pages readable + toggle script
    injectMinimalBundle(root);

    // Download images and rewrite src
    await Promise.all(
      Array.from(images).map(async (src) => {
        try {
          const abs = new URL(src, urlObj).toString();
          const assetName = assetFilename(abs);
          const outPath = path.join(ASSETS_DIR, assetName);
          if (!fs.existsSync(outPath)) {
            const res = await axios.get(abs, { responseType: 'arraybuffer', timeout: 45000 });
            fs.writeFileSync(outPath, res.data);
            console.log('  📥', assetName);
          }
          // rewrite all occurrences of this src
          root.querySelectorAll(`img[src="${src}"]`).forEach((img) => {
            img.setAttribute('src', `assets/${assetName}`);
          });
        } catch (e) {
          console.warn('  ! image failed', src);
        }
      })
    );

    // Save HTML
    const outFile = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outFile, root.toString());

    visited.set(url, { title, filename });
    console.log(`  ✅ Saved: site/${filename}`);
  } catch (err) {
    console.warn('  ! Error on page:', err?.message || err);
  } finally {
    await page.close();
  }
}

await browser.close();

// After crawl, do a link fix pass with the actual filenames we know now
for (const [url, meta] of visited) {
  const filePath = path.join(OUTPUT_DIR, meta.filename);
  let html = fs.readFileSync(filePath, 'utf8');
  for (const [u2, m2] of visited) {
    try {
      const pattern = new RegExp(escapeRegExp(u2), 'g');
      html = html.replace(pattern, m2.filename);
    } catch {}
  }
  fs.writeFileSync(filePath, html, 'utf8');
}

console.log('\\n🎉 Done. Static site in ./site');

// ---------------- helpers ----------------
function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = ''; // drop client-side anchors
    return x.toString();
  } catch { return u; }
}

function isNotionPage(u) {
  try {
    const x = new URL(u);
    // Notion public pages usually include a 32-char id at the end
    return /[0-9a-f]{32}/i.test(x.pathname.replace(/-/g, ''));
  } catch { return false; }
}

function uniqueSlug(title, map) {
  let base = slugify(title, { lower: true, strict: true }) || 'page';
  base = base.slice(0, 60);
  let slug = base;
  let i = 2;
  const used = new Set(Array.from(map.values()).map(v => v.filename.replace(/\\.html$/, '')));
  while (used.has(slug)) { slug = `${base}-${i++}`; }
  return slug;
}

function assetFilename(u) {
  const id = Buffer.from(u).toString('base64').replace(/[^a-z0-9]/gi, '').slice(0,24);
  const ext = (u.split('?')[0].split('#')[0].match(/\\.(png|jpe?g|gif|svg|webp)$/i)?.[0] || '.bin');
  return `${id}${ext}`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
}

function injectMinimalBundle(root) {
  const head = root.querySelector('head');
  const body = root.querySelector('body');
  if (!head || !body) return;

  const style = parse(`<style>
  body{max-width:900px;margin:40px auto;padding:0 20px;line-height:1.6;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
  img{max-width:100%;height:auto;}
  a{text-decoration:none;}
  .container{display:block;}
  .toc{position:sticky;top:20px;max-height:80vh;overflow:auto;padding-left:0;}
  details{border:1px solid #e6e6e6;border-radius:8px;padding:10px 14px;margin:10px 0;}
  summary{cursor:pointer;font-weight:600;}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;}
</style>`);
  head.appendChild(style);

  const script = parse(`<script>
(function(){
  // Make generic disclosure widgets work if markup uses aria-controls / aria-expanded
  document.addEventListener('click', function(e){
    const t = e.target.closest('[aria-controls], summary');
    if(!t) return;
    if(t.matches('summary')) return; // native <details>
    const id = t.getAttribute('aria-controls');
    if(!id) return;
    const el = document.getElementById(id);
    if(!el) return;
    const visible = getComputedStyle(el).display !== 'none';
    el.style.display = visible ? 'none' : 'block';
    const exp = t.getAttribute('aria-expanded');
    if(exp !== null) t.setAttribute('aria-expanded', (!visible).toString());
    e.preventDefault();
  }, true);
})();
</script>`);
  body.appendChild(script);
}
