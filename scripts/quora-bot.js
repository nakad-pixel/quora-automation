// scripts/quora-bot.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';

const LOG = path.resolve('./run-log.txt');
async function appendLog(line){ await fs.appendFile(LOG, `${new Date().toISOString()}  ${line}\n`); console.log(line); }

const {
  QUORA_EMAIL,
  QUORA_PASSWORD,
  QUORA_SESSION_TOKEN, // optional: the 'm-b' cookie value copied from your browser
  RETRY_MAX = '1',
  NOTIFY_WEBHOOK = '',
  KW = '',
  TITLE = '',
  SNIPPET = '',
  URL = '',
  MODE = 'question' // 'space' or 'question'
} = process.env;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function rand(min, max){ return Math.floor(Math.random()*(max-min+1))+min; }

async function setSessionCookie(page){
  if(!QUORA_SESSION_TOKEN) return false;
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
  } catch(e){
    await appendLog('Failed to set session cookie: '+ String(e));
    return false;
  }
}

async function safeScreenshot(page, name){
  try {
    await fs.ensureDir('tmp-screens');
    const p = path.join('tmp-screens', name);
    await page.screenshot({ path: p, fullPage: true }).catch(()=>{});
    await appendLog('Saved screenshot: '+p);
  } catch(e){ /* ignore */ }
}

async function checkForChallenge(page){
  const content = await page.content();
  if(/captcha|verify|are you human|check your email|challenge/i.test(content)) {
    await appendLog('Challenge/CAPTCHA detected in page content.');
    return true;
  }
  return false;
}

async function loginWithCredentials(page){
  try {
    await appendLog('Attempting login via credentials...');
    await page.goto('https://www.quora.com/', { waitUntil: 'networkidle2' });
    await sleep(rand(800,1500));
    // Try open login UI if needed
    const emailSel = 'input[name="email"], input[type="email"]';
    const passSel = 'input[name="password"], input[type="password"]';
    const loginLink = await page.$('a[href*="login"], a[href="/login"]');
    if(loginLink) {
      await loginLink.click().catch(()=>{});
      await page.waitForTimeout(rand(800,1400)).catch(()=>{});
    }
    if(!(await page.$(emailSel))){
      // sometimes Quora shows a popup variant - try forcing /login
      await page.goto('https://www.quora.com/login', { waitUntil: 'networkidle2' });
      await sleep(rand(800,1500));
    }
    await page.waitForSelector(emailSel, { timeout: 12000 });
    await page.type(emailSel, QUORA_EMAIL, { delay: rand(50,120) });
    await page.type(passSel, QUORA_PASSWORD, { delay: rand(50,120) });
    await sleep(rand(400,900));

    // Submit - try multiple approaches
    const submitBtn = await page.$('input[type="submit"], button[type="submit"], button:has-text("Login")').catch(()=>null);
    if(submitBtn) {
      await submitBtn.click().catch(()=>{});
    } else {
      await page.keyboard.press('Enter');
    }
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});
    await appendLog('Post-login page loaded.');
    // Quick check for challenge
    if(await checkForChallenge(page)){
      await safeScreenshot(page, 'login-challenge.png');
      return false;
    }
    // check if login succeeded by presence of profile menu or absence of login inputs
    const stillLogin = await page.$('input[name="email"], input[type="email"]');
    if(stillLogin){
      await appendLog('Login did not appear to succeed (login inputs still present).');
      await safeScreenshot(page, 'login-failed.png');
      return false;
    }
    await appendLog('Login appears successful.');
    return true;
  } catch(e){
    await appendLog('Login error: '+String(e));
    await safeScreenshot(page, 'login-exception.png');
    return false;
  }
}

async function findQuestionFromKeyword(page, keyword){
  const q = keyword || TITLE || 'AI tools for small business';
  const url = `https://www.quora.com/search?q=${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(rand(1800,2800));
  // Collect likely question anchors
  const candidates = await page.$$eval('a[href^="/"]', anchors =>
    anchors.map(a => ({ text: (a.textContent||'').trim(), href: a.getAttribute('href') }))
      .filter(x => x && x.text && x.text.endsWith('?') && x.text.length >= 35 && x.text.length <= 140)
      .slice(0, 12)
  );
  if(!candidates || candidates.length===0) return null;
  // rank by relevance keywords
  candidates.sort((a,b)=>{
    const score=(t)=>{t=t.toLowerCase(); let s=0; if(t.includes('ai')) s+=3; if(t.includes('small business')) s+=3; if(t.includes('tool')) s+=1; if(t.includes('automation')) s+=1; return s;};
    return score(b.text)-score(a.text);
  });
  const chosen = candidates[0];
  const full = new URL(chosen.href, 'https://www.quora.com').toString();
  await page.goto(full, { waitUntil: 'domcontentloaded' });
  await sleep(rand(1600,2600));
  return { title: chosen.text, url: full };
}

async function openEditor(page){
  // try several selectors; Quora UI changes frequently
  const editorSelectors = [
    '[contenteditable="true"]',
    'div[role="textbox"]',
    '.q-text_editor',
  ];
  for(const sel of editorSelectors){
    const el = await page.$(sel).catch(()=>null);
    if(el) return el;
  }
  // try clicking "Answer" then wait for editor
  const answerBtn = await page.$x("//button[contains(., 'Answer') or contains(., 'Write')]").catch(()=>[]);
  if(answerBtn && answerBtn.length) {
    await answerBtn[0].click().catch(()=>{});
    await sleep(rand(1200,2000));
    for(const sel of editorSelectors){
      const el = await page.$(sel).catch(()=>null);
      if(el) return el;
    }
  }
  return null;
}

async function typeHuman(el, text){
  // chunk by words and randomize delays
  const parts = text.split(/\s+/);
  for(const p of parts){
    try{ await el.type(p + ' ', { delay: rand(30,120) }); } catch(e){ /* ignore typing errors */ }
    await sleep(rand(10,80));
  }
}

async function clickPost(page){
  // try multiple variations of post/submit
  const xpaths = [
    "//button[contains(., 'Post')]",
    "//div[@role='button' and (contains(., 'Post') or contains(., 'Publish'))]",
    "//button[contains(., 'Submit') or contains(., 'Publish')]"
  ];
  for(const xp of xpaths){
    const el = await page.$x(xp).catch(()=>[]);
    if(el && el.length){
      try{ await el[0].click(); await sleep(rand(1600,2600)); return true; } catch(e){ /* continue */ }
    }
  }
  return false;
}

async function mainAttempt(){
  // Main attempt: open browser page, set session or login, find question, post answer.
  const browser = await puppeteer.launch({
    headless: 'new',   // headless: 'new' uses newer headless mode; adjust to 'false' for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try{
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    await appendLog('Browser launched.');

    // Try session cookie first
    const usedCookie = await setSessionCookie(page);
    if(usedCookie) {
      await appendLog('Session cookie applied; verifying session.');
      await page.goto('https://www.quora.com/', { waitUntil: 'domcontentloaded' });
      await sleep(rand(1000,1800));
      if(await checkForChallenge(page)) {
        await safeScreenshot(page, 'challenge-after-cookie.png');
        await appendLog('Challenge detected after cookie; will attempt credential login fallback.');
      } else {
        // check if still shows login inputs
        const loginInputs = await page.$('input[name="email"], input[type="email"]');
        if(!loginInputs) {
          await appendLog('Session cookie appears to be valid—logged in.');
        } else {
          await appendLog('Session cookie did not yield an authenticated session.');
        }
      }
    }

    // If not logged in, perform credential login
    const loginState = await page.$('input[name="email"], input[type="email"]');
    if(loginState) {
      const ok = await loginWithCredentials(page);
      if(!ok) {
        await appendLog('Login with credentials failed or challenged; aborting attempt.');
        await safeScreenshot(page, 'login-failed-final.png');
        await browser.close();
        return { ok: false, reason: 'login_failed' };
      }
    }

    // find a relevant question
    const found = await findQuestionFromKeyword(page, KW || TITLE || 'AI tools for small business');
    if(!found) {
      await appendLog('No suitable question found for keyword; aborting.');
      await safeScreenshot(page, 'no-question-found.png');
      await browser.close();
      return { ok: false, reason: 'no_question' };
    }
    await appendLog(`Selected question: ${found.title} -> ${found.url}`);

    // Compose answer (friendly, helpful, link at end)
    let summary = SNIPPET || (`Short guide: ${TITLE || KW || 'AI tools for small business'}`);
    if(summary.length < 80) summary = summary + ' — quick summary: these tools help automate invoices, marketing, and customer support for small businesses.';
    const answer = `${summary}\n\nFull guide & examples: ${URL || ''}\n\nI tested these tools and used real small-business scenarios when writing the guide.`;

    // open editor and type
    const editor = await openEditor(page);
    if(!editor){
      await appendLog('Editor could not be opened; aborting.');
      await safeScreenshot(page, 'editor-missing.png');
      await browser.close();
      return { ok:false, reason:'editor_missing' };
    }
    await typeHuman(editor, answer);
    await sleep(rand(800,1400));

    // click post
    const posted = await clickPost(page);
    if(!posted){
      await appendLog('Post/Submit button not found or click failed.');
      await safeScreenshot(page, 'no-post-button.png');
      await browser.close();
      return { ok:false, reason:'post_failed' };
    }

    await appendLog('Posted successfully; waiting for confirmation...');
    await sleep(rand(1800,3000));
    await safeScreenshot(page, 'posted-confirmation.png'); // capture confirmation area

    await browser.close();
    return { ok:true, url: found.url };
  } catch(err){
    await appendLog('Exception during attempt: ' + String(err));
    try{ await fs.ensureDir('tmp-screens'); }catch(e){}
    try{ await browser && (await (await browser.pages())[0].screenshot({ path: 'tmp-screens/exception.png' })); }catch(e){}
    if(browser) await browser.close().catch(()=>{});
    return { ok:false, reason:'exception', error: String(err) };
  }
}

async function notifyWebhook(payload){
  if(!NOTIFY_WEBHOOK) return;
  try{
    const u = NOTIFY_WEBHOOK;
    // simple POST with node-fetch-like method using built-in node
    const data = JSON.stringify(payload);
    const https = u.startsWith('https://') ? await import('https') : await import('http');
    const parsed = new URL(u);
    const client = parsed.protocol === 'https:' ? https.default : https.default;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type':'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = client.request(options, res=>{
      appendLog('Notify webhook responded: ' + res.statusCode);
    });
    req.on('error', err => appendLog('Notify webhook error: ' + String(err)));
    req.write(data);
    req.end();
  } catch(e){
    await appendLog('Failed to notify webhook: ' + String(e));
  }
}

(async function main(){
  await fs.remove(LOG).catch(()=>{});
  await appendLog('--- Starting Quora bot run ---');
  const tries = Math.max(1, parseInt(RETRY_MAX||'1',10));
  for(let i=1;i<=tries;i++){
    await appendLog(`Attempt ${i}/${tries}`);
    const result = await mainAttempt();
    if(result.ok){
      await appendLog('Posting succeeded: ' + (result.url || 'unknown'));
      await notifyWebhook({ status:'success', questionUrl: result.url, title: TITLE, postUrl: URL });
      process.exit(0);
    } else {
      await appendLog('Attempt failed: ' + (result.reason || result.error || 'unknown'));
      await notifyWebhook({ status:'attempt_failed', attempt:i, reason: result.reason || result.error });
      if(i < tries){
        const backoff = 2000 * i * i; // exponential-ish
        await appendLog('Waiting before retry: ' + backoff + 'ms');
        await sleep(backoff);
      } else {
        await appendLog('All attempts exhausted; exiting with non-zero code.');
        await notifyWebhook({ status:'failed', reason: result.reason || result.error });
        process.exit(2);
      }
    }
  }
})();
