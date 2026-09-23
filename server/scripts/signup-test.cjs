/**
 * Signup navigation tests.
 *
 * The existing browser suite opened the PIN sheet and checked it said "PIN".
 * It never pressed Continue — which is exactly why Continue could ship wired to
 * nothing and every suite stayed green. These tests press the buttons.
 *
 * Every step is walked forwards, backwards and out: Continue must advance,
 * Back must return with what was typed still there, Cancel must warn before
 * abandoning an account that is not open yet.
 */
const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log('  ✓', m); };
const bad = (m, got) => { fail += 1; console.log('  ✗', m, '—', got); };

/* Signed out, with a server that answers everything a signup needs. */
function boot(file, { features = {}, registerFails = false } = {}) {
  const html = fs.readFileSync('/home/claude/repo/' + file, 'utf8');
  const errors = [];
  const calls = [];
  const store = {};

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://pokzbank.org/' + file,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      const api = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
      Object.defineProperty(w, 'sessionStorage', { value: api });
      Object.defineProperty(w, 'localStorage', { value: { getItem: () => null, setItem() {}, removeItem() {} } });
      w.fetch = (url, opts = {}) => {
        const u = String(url);
        calls.push(`${opts.method || 'GET'} ${u.replace('https://pokzbank.org', '')}`);
        const send = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
        if (u.includes('/api/health')) return send({ status: 'ok' });
        if (u.includes('/api/config')) return send({ features });
        if (u.includes('/api/v1/auth/register')) {
          return registerFails
            ? send({ error: { code: 'conflict', message: 'That number or email already has an account' } }, 409)
            : send({ tokens: { accessToken: 'tok', refreshToken: 'ref' }, customer: { id: 'c1', full_name: 'Ama Boateng', msisdn: '+233241234567' } });
        }
        if (u.includes('/api/accounts/')) return send({ accounts: [], transactions: [], mustChangePin: true, kycStatus: 'unverified', onboardingComplete: false });
        if (u.includes('/api/otp/request')) return send({ challengeId: 'ch1', demoCode: '123456' });
        if (u.includes('/api/otp/verify')) return send({ stepUpToken: 'st1' });
        if (u.includes('/api/pin/set')) return send({ ok: true });
        if (u.includes('/api/v1/kyc/ghana-card')) return send({ status: 'verified', account: { accountNumber: '5010000009', currency: 'GHS' } });
        if (u.includes('/api/v1/remittance/corridors')) {
          return features.remittance
            ? send({ corridors: [{ code: 'NG', country: 'Nigeria', currency: 'NGN', methods: ['bank'], deliveryMinutes: 10 }] })
            : send({ error: { code: 'feature_disabled', message: 'Not found' } }, 404);
        }
        if (u.includes('/api/v1/remittance/quotes')) {
          return send({ quote: { id: 'q1', corridor: 'NG', country: 'Nigeria', currency: 'NGN', debitMinor: 50000, feeMinor: 1500, sendMinor: 48500, rate: 0.0915, receives: 5300.55, deliveryMinutes: 10, expiresAt: new Date(Date.now() + 600000).toISOString() } });
        }
        return send({});
      };
      w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      w.onerror = (m) => errors.push(String(m));
    }
  });
  return { dom, w: dom.window, d: dom.window.document, errors, calls };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(file) {
  console.log(`\n── ${file} · signup navigation`);
  const { w, d, errors } = boot(file);
  await wait(700);

  const text = () => (d.body.textContent || '').replace(/\s+/g, ' ').trim();
  const sheet = () => (d.getElementById('sheet')?.textContent || '').replace(/\s+/g, ' ').trim();
  const gate = () => (d.querySelector('.gate')?.textContent || '').replace(/\s+/g, ' ').trim();
  const screen = () => (gate() || sheet() || text());
  const tap = (sel) => { const el = d.querySelector(sel); if (!el) return false; el.click(); return true; };
  const tapText = (label) => {
    const el = [...d.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label);
    if (!el) return false; el.click(); return true;
  };
  const type = (id, value) => {
    const el = d.getElementById(id);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
    return true;
  };
  const valueOf = (id) => d.getElementById(id)?.value ?? null;

  /* ---------------------------------------------------------- the gate */
  d.querySelector('.gate') ? ok('signed out shows the gate') : bad('signed out shows the gate', text().slice(0, 60));
  tap('[data-gate="mode-open"]');
  await wait(50);
  valueOf('gName') !== null ? ok('open-an-account form shows') : bad('open-an-account form shows', gate().slice(0, 60));

  /* A short name must not cost you the rest of the form. */
  type('gName', 'Am');
  type('gMsisdn2', '0241234567');
  type('gEmail', 'ama@example.com');
  type('gPass2', 'a-long-password');
  tap('[data-gate="open"]');
  await wait(50);
  /full name/i.test(gate()) ? ok('a short name is refused') : bad('a short name is refused', gate().slice(0, 80));
  valueOf('gMsisdn2') === '0241234567' ? ok('the number survives the error') : bad('the number survives the error', valueOf('gMsisdn2'));
  valueOf('gPass2') === 'a-long-password' ? ok('the password survives the error') : bad('the password survives the error', valueOf('gPass2'));

  /* Check-your-details, and back out of it to fix a digit. */
  type('gName', 'Ama Boateng');
  tap('[data-gate="open"]');
  await wait(50);
  /Check your details/i.test(gate()) ? ok('details are shown back before anything is created') : bad('details shown back', gate().slice(0, 80));
  gate().includes('0241234567') ? ok('the number is on the check screen') : bad('number on check screen', gate().slice(0, 100));

  tap('[data-gate="mode-open"]');
  await wait(50);
  valueOf('gMsisdn2') === '0241234567' ? ok('Back returns to the form, still filled in') : bad('Back returns filled in', valueOf('gMsisdn2'));

  tap('[data-gate="open"]');
  await wait(50);
  tap('[data-gate="confirm-open"]');
  await wait(400);

  /* ------------------------------------------------------ setting a PIN */
  /Set a new PIN/i.test(screen()) ? ok('creating the account leads to the PIN step') : bad('leads to the PIN step', screen().slice(0, 80));

  const enterPin = async (digits) => {
    if (file === 'app.html') {
      for (const ch of digits) { w.eval(`padKey('${ch}')`); }
    } else {
      type('authInput', digits);
    }
    await wait(20);
  };

  await enterPin('1379');
  tapText('Continue') ? ok('Continue on the PIN step is wired') : bad('Continue on the PIN step is wired', 'no Continue button');
  await wait(100);
  /Confirm your new PIN/i.test(screen()) ? ok('Continue advances to confirm-PIN') : bad('Continue advances', screen().slice(0, 80));

  /* Back from confirm to set. */
  tapText('Back') ? ok('confirm-PIN offers Back') : bad('confirm-PIN offers Back', 'no Back button');
  await wait(100);
  /Set a new PIN/i.test(screen()) ? ok('Back returns to the PIN step') : bad('Back returns to the PIN step', screen().slice(0, 80));

  /* A mismatch must leave a usable screen, not a keypad with no buttons. */
  await enterPin('1379');
  tapText('Continue'); await wait(80);
  await enterPin('2468');
  tapText('Continue'); await wait(120);
  /did not match/i.test(screen()) ? ok('a mismatch says so') : bad('a mismatch says so', screen().slice(0, 80));
  [...d.querySelectorAll('button')].some((b) => /Continue/.test(b.textContent))
    ? ok('the mismatch screen still has a way forward') : bad('mismatch screen has a way forward', 'no buttons');

  /* Through to the code. */
  await enterPin('1379');
  tapText('Continue'); await wait(80);
  await enterPin('1379');
  tapText('Continue'); await wait(250);
  /Enter the code/i.test(screen()) ? ok('a matching PIN asks for the code') : bad('asks for the code', screen().slice(0, 80));

  /* Back from the code, and a new code without starting over. */
  tapText('Back'); await wait(120);
  /Set a new PIN/i.test(screen()) ? ok('Back from the code returns to the PIN') : bad('Back from the code', screen().slice(0, 80));
  await enterPin('1379');
  tapText('Continue'); await wait(80);
  await enterPin('1379');
  tapText('Continue'); await wait(250);
  tapText('Send a new code') ? ok('a new code can be asked for') : bad('a new code can be asked for', 'no resend button');
  await wait(200);

  /* Cancel must warn while the account is still unopened. */
  tapText('Cancel'); await wait(120);
  /not open yet/i.test(screen()) ? ok('Cancel warns instead of abandoning the signup') : bad('Cancel warns', screen().slice(0, 100));
  tapText('Keep going'); await wait(120);
  /Enter the code/i.test(screen()) ? ok('Keep going returns to where you were') : bad('Keep going returns', screen().slice(0, 80));

  /* Finish: the code, then identity. */
  await enterPin('123456');
  tapText('Confirm'); await wait(400);
  /Verify your identity/i.test(screen()) ? ok('the code leads straight to verification') : bad('leads to verification', screen().slice(0, 90));

  /* A malformed card number must not wipe the date of birth. */
  type('kycNo', 'GHA-1');
  type('kycDob', '1990-01-01');
  tap('[data-act="verifysubmit"]'); await wait(150);
  valueOf('kycDob') === '1990-01-01' ? ok('a bad card number keeps the date of birth') : bad('keeps the date of birth', valueOf('kycDob'));
  valueOf('kycNo') === 'GHA-1' ? ok('the card number stays for correction') : bad('card number stays', valueOf('kycNo'));

  type('kycNo', 'GHA-123456789-1');
  tap('[data-act="verifysubmit"]'); await wait(400);
  /account is open|5010000009/i.test(screen()) ? ok('verification opens the account') : bad('verification opens the account', screen().slice(0, 90));

  errors.length ? bad('no uncaught errors during signup', errors.slice(0, 2).join(' | ')) : ok('no uncaught errors during signup');
  w.close();
}

/* The flag decides whether the feature is on the screen at all. */
async function runFlag(file) {
  console.log(`\n── ${file} · remittance flag`);
  for (const on of [false, true]) {
    const { w, d, errors } = boot(file, { features: { remittance: on } });
    await wait(700);
    /* Only what is drawn on the screen counts. body.innerHTML includes the
       page's own inline script, whose source mentions every label in it — a
       search across the whole body reports the feature as visible even when
       nothing renders it. */
    const rendered = () => (d.getElementById('sheet')?.textContent || '')
      + (d.getElementById('view')?.textContent || '')
      + (d.getElementById('scroll')?.textContent || '');
    if (file === 'app.html') { try { w.eval('openPay()'); } catch { /* menu needs a profile */ } }
    else { try { w.eval("S.view='transfers'; render();"); } catch { /* view needs a profile */ } }
    await wait(120);
    const shown = /Send abroad/.test(rendered());
    shown === on
      ? ok(`flag ${on ? 'on' : 'off'}: "Send abroad" ${on ? 'appears' : 'is absent'}`)
      : bad(`flag ${on ? 'on' : 'off'}`, shown ? 'shown when off' : 'hidden when on');
    errors.length ? bad('no uncaught errors with the flag', errors[0]) : ok('no uncaught errors with the flag');
    w.close();
  }
}

(async () => {
  await run('app.html');
  await run('web.html');
  await runFlag('app.html');
  await runFlag('web.html');
  console.log(`\npassed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
