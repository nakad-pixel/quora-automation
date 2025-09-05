// scripts/quora-bot.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';

const LOG = path.resolve('./run-log.txt');
async function appendLog(line) {
  await fs.appendFile(LOG, `${new Date().toISOString()}  ${line}\n`);
  console.log(line);
}

// Load ENV secrets
const {
  QUORA_EMAIL,
  QUORA_PASSWORD,
  QUORA_SESSION_TOKEN, // optional cookie
  RETRY_MAX = '1',
  NOTIFY_WEBHOOK = ''
} = process.env;

// Load blog metadata from JSON
let blogMeta = {};
try {
  const metaPath = path.resolve('./latest-blog.json');
  blogMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  await appendLog(`Loaded blog metadata from ${metaPath}`);
} catch (e) {
  await appendLog('No latest-blog.json found or invalid JSON. Using fallbacks.');
}

const {
  TITLE = '',
  SNIPPET = '',
  URL = '',
  KW = ''
} = blogMeta;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// --- Session + Login Helpers ---
async function setSessionCookie(page) {
  if (!QUORA_SESSION_TOKEN) return false;
  try {
    const cookie = {
      name: 'm-b',
      value: QUORA_SESSION_TOKEN,
      domain: '.quora.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    };
    await page.setCookie(cookie);
    await appendLog('Session cookie set from secret.');
    return true;
  } catch (e) {
    await appendLog('Failed to set session cookie: ' + String(e));
    return false;
  }
}

async function checkForChallenge(page) {
  const content = await page.content();
  if (/captcha|verify|are you human|challenge/i.test(content)) {
    await appendLog('Challenge/CAPTCHA detected.');
    return true;
  }
  return false;
}

async function loginWithCredentials(page) {
  try {
    await appendLog('Attempting login via credentials...');
    await page.goto('https://www.quora.com/login', { waitUntil: 'networkidle2' });
    await page.type('input[name="email"]', QUORA_EMAIL, { delay: rand(50, 120) });
    await page.type('input[name="password"]', QUORA_PASSWORD, { delay: rand(50, 120) });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    if (await checkForChallenge(page)) return false;
    await appendLog('Login appears successful.');
    return true;
  } catch (e) {
    await appendLog('Login error: ' + String(e));
    return false;
  }
}

// --- Core Actions ---
async function findQuestionFromKeyword(page, keyword) {
  const q = keyword || TITLE || 'AI tools for small business';
  const url = `https://www.quora.com/search?q=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(rand(1800, 2800));

  const candidates = await page.$$eval('a[href^="/"]', anchors =>
    anchors.map(a => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') }))
      .filter(x => x && x.text && x.text.endsWith('?'))
      .slice(0, 10)
  );
  if (!candidates.length) return null;
  const chosen = candidates[0];
  const full = new URL(chosen.href, 'https://www.quora.com').toString();
  return { title: chosen.text, url: full };
}

async function openEditor(page) {
  const editor = await page.$('[contenteditable="true"]');
  return editor;
}

async function typeHuman(el, text) {
  const words = text.split(/\s+/);
  for (const w of words) {
    await el.type(w + ' ', { delay: rand(30, 120) });
    await sleep(rand(10, 80));
  }
}

async function clickPost(page) {
  const el = await page.$x("//button[contains(., 'Post') or contains(., 'Publish')]");
  if (el.length) {
    await el[0].click();
    await sleep(rand(1600, 2600));
    return true;
  }
  return false;
}

// --- Main Bot Run ---
async function mainAttempt() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    if (!(await setSessionCookie(page))) {
      if (!(await loginWithCredentials(page))) {
        await appendLog('Login failed. Aborting.');
        await browser.close();
        return { ok: false, reason: 'login_failed' };
      }
    }

    const found = await findQuestionFromKeyword(page, KW);
    if (!found) {
      await appendLog('No suitable question found.');
      await browser.close();
      return { ok: false, reason: 'no_question' };
    }

    await page.goto(found.url, { waitUntil: 'domcontentloaded' });
    const editor = await openEditor(page);
    if (!editor) return { ok: false, reason: 'editor_missing' };

    const answer = `${SNIPPET}\n\nFull blog: ${URL}`;
    await typeHuman(editor, answer);
    const posted = await clickPost(page);

    await browser.close();
    return { ok: posted, url: found.url };
  } catch (e) {
    await appendLog('Error: ' + e);
    await browser.close();
    return { ok: false, reason: 'exception' };
  }
}

// --- Main ---
(async function main() {
  await fs.remove(LOG).catch(() => {});
  const tries = Math.max(1, parseInt(RETRY_MAX, 10));
  for (let i = 1; i <= tries; i++) {
    const result = await mainAttempt();
    if (result.ok) {
      await appendLog('Posted successfully: ' + result.url);
      process.exit(0);
    } else {
      await appendLog('Attempt failed: ' + result.reason);
      if (i < tries) await sleep(2000 * i);
      else process.exit(1);
    }
  }
})();
