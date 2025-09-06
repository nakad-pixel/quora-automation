// scripts/quora-bot.js
import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';

const LOG_FILE = path.resolve('./run-log.txt');
const BLOG_META_PATH = path.resolve('./latest-blog.json');
const QUIA_LOG_PATH = path.resolve('./quora-log.json');

async function appendLog(line){
  await fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
}

const {
  QUORA_SESSION_TOKEN,
  QUORA_EMAIL,
  QUORA_PASSWORD,
  RETRY_MAX = '1',
  ENABLE_ENGAGE = 'false'
} = process.env;

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function rnd(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function humanDelay(){ return rnd(60,160); }

async function loadBlogMeta(){
  try {
    const json = await fs.readFile(BLOG_META_PATH, 'utf8');
    return JSON.parse(json);
  } catch(e){
    await appendLog('ERR: latest-blog.json not found or invalid.');
    return null;
  }
}

// set session cookie 'm-b' if provided
async function setSessionCookie(page){
  if(!QUORA_SESSION_TOKEN) return false;
  try{
    await page.setCookie({
      name: 'm-b',
      value: QUORA_SESSION_TOKEN,
      domain: '.quora.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax'
    });
    await appendLog('Applied session cookie (m-b).');
    return true;
  } catch(e){
    await appendLog('Failed to set session cookie: '+String(e));
    return false;
  }
}

async function detectChallenge(page){
  const html = await page.content();
  if(/captcha|are you human|verify|challenge|two-step/i.test(html)) return true;
  return false;
}

async function loginWithCreds(page){
  if(!QUORA_EMAIL || !QUORA_PASSWORD){
    await appendLog('No credentials provided.');
    return false;
  }
  try {
    await appendLog('Logging in with credentials...');
    await page.goto('https://www.quora.com/login', { waitUntil: 'networkidle2' });
    await sleep(rnd(900,1500));
    const emailSel = 'input[name="email"], input[type="email"]';
    const passSel = 'input[name="password"], input[type="password"]';
    await page.waitForSelector(emailSel, { timeout: 10000 });
    await page.type(emailSel, QUORA_EMAIL, { delay: rnd(50,120) });
    await page.type(passSel, QUORA_PASSWORD, { delay: rnd(50,120) });
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(()=>{});
    if(await detectChallenge(page)){ await appendLog('Login triggered challenge'); return false; }
    // quick check: is login input still present?
    const still = await page.$('input[name="email"], input[type="email"]');
    if(still) { await appendLog('Login failed - still on login inputs'); return false; }
    await appendLog('Credential login successful (heuristic).');
    return true;
  } catch(e){
    await appendLog('Login exception: '+String(e));
    return false;
  }
}

// Parse numbers from strings like "37 answers" or "1.2k followers"
function parseNumberFromText(t){
  if(!t) return 0;
  const cleaned = t.replace(/,/g,'').trim();
  const match = cleaned.match(/([\d\.]+)\s*(k|m)?/i);
  if(!match) return 0;
  let num = parseFloat(match[1]);
  const unit = (match[2]||'').toLowerCase();
  if(unit==='k') num *= 1000;
  if(unit==='m') num *= 1000000;
  return Math.round(num);
}

// Visit search and collect candidate question links
async function collectCandidatesFromSearch(page, keyword, maxCandidates=10){
  const q = encodeURIComponent(keyword);
  const url = `https://www.quora.com/search?q=${q}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(rnd(1400,2600));
  // pull anchors whose text ends with '?'
  const anchors = await page.$$eval('a[href^="/"]', as =>
    as.map(a => ({ text: (a.textContent||'').trim(), href: a.getAttribute('href') }))
      .filter(x => x && x.text && x.text.endsWith('?'))
      .slice(0, 40)
  );
  // unique by href
  const map = new Map();
  for(const a of anchors) if(!map.has(a.href)) map.set(a.href, a);
  return Array.from(map.values()).slice(0, maxCandidates);
}

// Score candidate by visiting each and extracting follower & answer counts
async function scoreCandidates(page, candidates, keyword){
  const scored = [];
  for(const c of candidates){
    try{
      const full = new URL(c.href, 'https://www.quora.com').toString();
      await page.goto(full, { waitUntil: 'domcontentloaded' });
      await sleep(rnd(1200,2200));
      const html = await page.content();
      if(/captcha|verify|challenge/i.test(html)){
        await appendLog('Challenge detected during scoring; abort scoring.');
        return scored; // avoid further scraping
      }
      // Attempt to find "followers" count
      let followers = 0, answers = 0;
      try {
        // look for text "followers" near number
        const fsel = await page.$$eval('div, span', nodes =>
          nodes.map(n => ({ text: n.textContent||'' })).slice(0,200)
        );
        const joined = fsel.map(x=>x.text).join('|||').replace(/\n/g,' ');
        const fMatch = joined.match(/([\d\.,]+\s*(k|m)?)[^\|]{0,40}followers/i);
        const aMatch = joined.match(/([\d\.,]+\s*(k|m)?)[^\|]{0,40}answers/i);
        followers = fMatch ? parseNumberFromText(fMatch[1]) : 0;
        answers = aMatch ? parseNumberFromText(aMatch[1]) : 0;
      } catch(e){}
      // fallback: try simple page.querySelector for common selectors
      if(!followers){
        try {
          const f = await page.$eval('[data-testid*="followers"], [class*="Followers"]', el => el.textContent || '');
          followers = parseNumberFromText(f);
        } catch(e){}
      }
      if(!answers){
        try {
          const a = await page.$eval('[data-testid*="answers"], [class*="Answers"]', el => el.textContent || '');
          answers = parseNumberFromText(a);
        } catch(e){}
      }

      // Compute simple score:
      // - keyword presence in title gives small boost
      const kwScore = (c.text.toLowerCase().includes(keyword.toLowerCase()) ? 1 : 0);
      // - follower weight (log)
      const followerScore = Math.log10(1 + followers) * 1.5;
      // - low answer count boost (prefer questions with few answers)
      const answerScore = (answers<=2 ? 2 : Math.max(0, 1 - (answers / 20)));
      // final
      const score = kwScore*2 + followerScore + answerScore;
      scored.push({ href: full, text: c.text, followers, answers, score });
      await appendLog(`Candidate: "${c.text}" → followers:${followers}, answers:${answers}, score:${score.toFixed(2)}`);
    } catch(e){
      await appendLog('Scoring candidate error: '+String(e));
    }
    // small pause to look human
    await sleep(rnd(600,1200));
  }
  // sort by score desc
  scored.sort((a,b)=>b.score - a.score);
  return scored;
}

// open question and post answer
async function postAnswerOnQuestion(page, questionUrl, answerText){
  await page.goto(questionUrl, { waitUntil: 'domcontentloaded' });
  await sleep(rnd(1200,2000));
  if(await detectChallenge(page)){ await appendLog('Challenge before posting; abort.'); return false; }
  // try to open editor
  let editor = null;
  const editorSelectors = ['[contenteditable="true"]', 'div[role="textbox"]', '.q-text_editor'];
  for(const sel of editorSelectors){
    try{
      const el = await page.$(sel);
      if(el){ editor = el; break; }
    } catch {}
  }
  // If no editor visible, try clicking "Answer" button then find editor
  if(!editor){
    try{
      const btn = await page.$x("//button[contains(., 'Answer') or contains(., 'Write')]");
      if(btn && btn.length){ await btn[0].click(); await sleep(rnd(900,1500)); }
      for(const sel of editorSelectors){
        const el = await page.$(sel);
        if(el){ editor = el; break; }
      }
    } catch(e){}
  }
  if(!editor){ await appendLog('Editor not found'); return false; }

  // Type answer like a human
  for(const chunk of answerText.split(/\s+/)){
    try{ await editor.type(chunk + ' ', { delay: rnd(30,120) }); } catch(e){}
    if(Math.random() < 0.03) await sleep(rnd(400,1200));
  }
  await sleep(rnd(600,1200));
  // Try clicking Post / Submit button
  const xp = ["//button[contains(., 'Post') or contains(., 'Publish')]","//div[@role='button' and (contains(., 'Post') or contains(., 'Publish'))]"];
  for(const x of xp){
    try{
      const el = await page.$x(x);
      if(el && el.length){ await el[0].click(); await sleep(rnd(1000,2200)); return true; }
    } catch(e){}
  }
  await appendLog('Could not find post button');
  return false;
}

// attempt to add to relevant Space (best-effort)
async function tryPostToSpace(page, keyword, title, snippet, url){
  try {
    // Search for spaces using type filter (Quora UI changes; this is best-effort)
    const q = encodeURIComponent(keyword);
    const sUrl = `https://www.quora.com/search?q=${q}&type=space`;
    await page.goto(sUrl, { waitUntil: 'domcontentloaded' });
    await sleep(rnd(1600,2600));
    // Find first space link
    const s = await page.$$eval('a[href*="/space/"]', links => links.map(l=>({text:l.textContent||'', href:l.getAttribute('href')})).slice(0,5));
    if(!s || s.length===0) { await appendLog('No spaces found (best-effort).'); return false; }
    const chosen = s[0];
    const full = new URL(chosen.href, 'https://www.quora.com').toString();
    await page.goto(full, { waitUntil: 'domcontentloaded' });
    await sleep(rnd(1200,2000));
    // Try "Create post" or "Write" button
    const createBtn = await page.$x("//button[contains(., 'Create Post') or contains(., 'Post') or contains(., 'Write')]");
    if(createBtn && createBtn.length){ await createBtn[0].click(); await sleep(rnd(900,1500)); }
    // Find editor and type
    const editor = await page.$('[contenteditable="true"], div[role="textbox"]');
    if(!editor){ await appendLog('Space editor not found'); return false; }
    const postText = `${snippet}\n\nFull article: ${url}`;
    for(const w of postText.split(/\s+/)){ await editor.type(w+' ', { delay: rnd(30,120) }); }
    // click Publish
    const pub = await page.$x("//button[contains(., 'Post') or contains(., 'Publish')]");
    if(pub && pub.length){ await pub[0].click(); await sleep(rnd(1200,2200)); await appendLog('Posted to Space: '+full); return true; }
  } catch(e){
    await appendLog('Space post error: '+String(e));
  }
  return false;
}

// optional engagement: upvote top answers and/or leave a short comment
async function engageOnQuestion(page, questionUrl, blogUrl){
  try{
    // open question page (should already be open)
    await page.goto(questionUrl, { waitUntil: 'domcontentloaded' });
    await sleep(rnd(1200,2000));
    // find existing answers' upvote buttons
    const upvoteButtons = await page.$x("//button[contains(@aria-label,'Upvote') or contains(@aria-label,'upvote')]");
    if(upvoteButtons && upvoteButtons.length){
      // upvote the top 1 answer
      try{ await upvoteButtons[0].click(); await appendLog('Upvoted a top answer (heuristic).'); } catch(e){}
    }
    // optionally post a supportive comment on the top answer (very light)
    const commentBtns = await page.$x("//button[contains(., 'Add a comment') or contains(., 'Comment')]");
    if(commentBtns && commentBtns.length){
      // open comment input
      await commentBtns[0].click().catch(()=>{});
      await sleep(rnd(800,1200));
      const commentBox = await page.$('[contenteditable="true"], textarea');
      if(commentBox){
        const comment = `Nice point — I expanded on this in my article: ${blogUrl}`;
        for(const w of comment.split(/\s+/)){ await commentBox.type(w+' ', { delay: rnd(30,120) }); }
        // try to submit
        const submit = await page.$x("//button[contains(., 'Add') or contains(., 'Comment') or contains(., 'Post')]");
        if(submit && submit.length){ await submit[0].click().catch(()=>{}); await appendLog('Posted a short comment.'); }
      }
    }
  } catch(e){
    await appendLog('Engagement error: '+String(e));
  }
}

// main attempt orchestration
async function attemptPost(meta){
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({width:1280, height:800});
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');

  try {
    // session-first login
    let sessionOk = await setSessionCookie(page);
    if(sessionOk){
      await page.goto('https://www.quora.com/', { waitUntil: 'domcontentloaded' });
      await sleep(rnd(900,1400));
      if(await detectChallenge(page)){
        await appendLog('Challenge after cookie — will fallback to credentials.');
        sessionOk = false;
      } else {
        const stillLogin = await page.$('input[name="email"], input[type="email"]');
        if(stillLogin) sessionOk = false;
      }
    }
    if(!sessionOk){
      const credOk = await loginWithCreds(page);
      if(!credOk){
        await appendLog('Both cookie and credentials failed; aborting.');
        await browser.close();
        return { ok:false, reason:'auth_failed' };
      }
    }

    // Smart question selection
    const candidates = await collectCandidatesFromSearch(page, meta.KW || meta.TITLE || '');
    if(!candidates || candidates.length===0){
      await appendLog('No search candidates found.');
      await browser.close();
      return { ok:false, reason:'no_candidates' };
    }
    const scored = await scoreCandidates(page, candidates, meta.KW || meta.TITLE || '');
    if(!scored || scored.length===0){
      await appendLog('Scoring returned none.');
      await browser.close();
      return { ok:false, reason:'scoring_empty' };
    }

    const chosen = scored[0];
    await appendLog(`Chosen question: ${chosen.text} (${chosen.href})`);

    // Build answer: snippet + CTA + blog url
    const snippet = meta.SNIPPET || (meta.TITLE ? (meta.TITLE + ' - short summary.') : 'Short overview.');
    const answer = `${snippet}\n\nRead the full guide: ${meta.URL}\n\nIf you want specifics for your business, ask and I’ll share examples.`;

    // Post on question
    const posted = await postAnswerOnQuestion(page, chosen.href, answer);
    if(!posted){
      await appendLog('Posting to question failed. Trying space post (best-effort).');
      const spPosted = await tryPostToSpace(page, meta.KW || meta.TITLE || '', meta.TITLE, snippet, meta.URL);
      if(!spPosted){
        await appendLog('Space post also failed.');
        await browser.close();
        return { ok:false, reason:'post_failed' };
      } else {
        // recorded as space post
        await appendLog('Space post success.');
        await browser.close();
        return { ok:true, mode:'space', target: 'space' };
      }
    }

    // optional engagement
    if(ENABLE_ENGAGE === 'true' || ENABLE_ENGAGE === '1') {
      await sleep(rnd(800,1400));
      await engageOnQuestion(page, chosen.href, meta.URL);
    }

    await appendLog('Posted answer successfully.');
    await browser.close();
    return { ok:true, mode:'question', target: chosen.href };
  } catch(e){
    await appendLog('Fatal attempt error: '+String(e));
    try{ await page.screenshot({ path: 'tmp-screens/error.png', fullPage: true }); } catch {}
    if(browser) await browser.close();
    return { ok:false, reason:'exception', error:String(e) };
  }
}

async function appendQuoraLog(entry){
  let arr = [];
  try { arr = fs.existsSync(QUIA_LOG_PATH) ? JSON.parse(await fs.readFile(QUIA_LOG_PATH,'utf8')) : []; } catch(e){ arr=[]; }
  arr.push(entry);
  await fs.writeFile(QUIA_LOG_PATH, JSON.stringify(arr, null, 2), 'utf8');
}

(async () => {
  await appendLog('=== Quora bot run start ===');
  const meta = await loadBlogMeta();
  if(!meta){ await appendLog('Missing blog meta; exiting'); process.exit(1); }

  const tries = Math.max(1, parseInt(RETRY_MAX||'1',10));
  for(let i=1;i<=tries;i++){
    await appendLog(`Attempt ${i}/${tries}`);
    const res = await attemptPost(meta);
    if(res.ok){
      const entry = { date: (new Date()).toISOString(), title: meta.TITLE || '', url: meta.URL || '', target: res.target || '', mode: res.mode || 'question' };
      await appendQuoraLog(entry);
      await appendLog('Appended to quora-log.json');
      process.exit(0);
    } else {
      await appendLog(`Attempt failed: ${res.reason || res.error || 'unknown'}`);
      if(i < tries){
        const backoff = 2000 * i * i;
        await appendLog('Backing off for '+backoff+'ms');
        await sleep(backoff);
        continue;
      } else {
        await appendLog('All attempts failed.');
        process.exit(2);
      }
    }
  }
})();