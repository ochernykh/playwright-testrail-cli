import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from '@playwright/test';
import OpenAI from 'openai';

const MAX_ARIA_CHARS = 5_000;   // per section
const MAX_TOTAL_CHARS = 22_000; // total ARIA content sent to GPT-4o (~5500 tokens)
const MAX_TABS = 8;
const MAX_SUBPAGES = 3;
const SPECS_DIR = 'specs';

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Помилка: OPENAI_API_KEY не встановлений у .env файлі.');
    process.exit(1);
  }
  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    model:   process.env.OPENAI_MODEL    || 'gpt-4o',
  };
}

function printUsage() {
  console.log(`
Використання:
  npm run ai:explore -- --url https://example.com
  npm run ai:explore -- --url https://example.com --section "Payments"
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { url: null, section: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':     opts.url     = args[++i]; break;
      case '--section': opts.section = args[++i]; break;
    }
  }
  return opts;
}

function slugifyUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  } catch {
    return `explore-${Date.now()}`;
  }
}

function truncate(str) {
  return str.length > MAX_ARIA_CHARS
    ? str.slice(0, MAX_ARIA_CHARS) + '\n...(truncated)'
    : str;
}

// ─── Page interaction ─────────────────────────────────────────────────────────

async function loadPage(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
  try { await page.waitForLoadState('networkidle', { timeout: 8_000 }); } catch {}
}

async function snapshot(page) {
  return truncate(await page.locator('body').ariaSnapshot());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.url) { printUsage(); process.exit(0); }

  const config = loadConfig();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  const systemPrompt = await fs.readFile(path.resolve('prompts/explorer-seed.md'), 'utf8');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  const sections = [];

  try {
    // Main page
    process.stdout.write(`Досліджую ${opts.url}... `);
    await loadPage(page, opts.url);
    const mainTitle = await page.title();
    sections.push({ label: mainTitle || 'Main', url: opts.url, aria: await snapshot(page) });
    console.log('✓');

    // Tabs on the main page
    const tabs = page.getByRole('tab');
    const tabCount = await tabs.count();
    if (tabCount > 0) {
      console.log(`  Знайдено ${tabCount} таб(ів), досліджую...`);
      for (let t = 0; t < Math.min(tabCount, MAX_TABS); t++) {
        const tabName = ((await tabs.nth(t).textContent()) ?? `Tab ${t + 1}`).trim();
        process.stdout.write(`  Таб "${tabName}"... `);
        try {
          await tabs.nth(t).click({ timeout: 5_000 });
          try { await page.waitForLoadState('networkidle', { timeout: 3_000 }); } catch {}
          sections.push({ label: `Таб: ${tabName}`, url: opts.url, aria: await snapshot(page) });
          console.log('✓');
        } catch (err) {
          console.log(`⚠ (${err.message.split('\n')[0]})`);
        }
      }
    }

    // Navigation sub-pages (same domain, from nav/header links)
    const baseHost = new URL(opts.url).hostname;
    const navLinks = await page.evaluate((host) =>
      [...document.querySelectorAll('nav a[href], header a[href]')]
        .map(a => a.href)
        .filter(h => { try { return new URL(h).hostname === host; } catch { return false; } })
        .filter((v, i, arr) => arr.indexOf(v) === i),
      baseHost
    );

    const subLinks = navLinks.filter(l => l !== opts.url).slice(0, MAX_SUBPAGES);
    for (const link of subLinks) {
      process.stdout.write(`  Сторінка ${link}... `);
      try {
        await loadPage(page, link);
        const subTitle = await page.title();
        sections.push({ label: subTitle || link, url: link, aria: await snapshot(page) });
        console.log('✓');
      } catch (err) {
        console.log(`⚠ (${err.message.split('\n')[0]})`);
      }
    }
  } finally {
    await browser.close();
  }

  // Build input for GPT-4o — cap total ARIA content to stay within TPM limits
  let totalChars = 0;
  const trimmedSections = sections.map(s => {
    const remaining = MAX_TOTAL_CHARS - totalChars;
    if (remaining <= 0) return null;
    const aria = s.aria.length > remaining ? s.aria.slice(0, remaining) + '\n...(truncated)' : s.aria;
    totalChars += aria.length;
    return { ...s, aria };
  }).filter(Boolean);

  if (trimmedSections.length < sections.length) {
    console.log(`  ⚠ Обрізано до ${trimmedSections.length}/${sections.length} секцій (ліміт токенів)`);
  }

  const content = trimmedSections
    .map(s => `## ${s.label}\nURL: ${s.url}\n\`\`\`\n${s.aria}\n\`\`\``)
    .join('\n\n---\n\n');

  const userContent = opts.section
    ? `Фокус на секції: "${opts.section}"\n\n${content}`
    : content;

  console.log(`\nГенерую план тестування (${trimmedSections.length} секцій)...`);

  const resp = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userContent },
    ],
  });

  const plan = resp.choices[0].message.content;
  await fs.mkdir(SPECS_DIR, { recursive: true });
  const outPath = path.resolve(`${SPECS_DIR}/${slugifyUrl(opts.url)}.md`);
  await fs.writeFile(outPath, plan, 'utf8');

  console.log(`\n  Секцій досліджено: ${sections.length}`);
  console.log(`  План збережено:    ${outPath}\n`);
}

main();
