const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');

const file = process.argv[2] || 'app.html';
const html = fs.readFileSync('/home/claude/repo/' + file, 'utf8');
const errors = [];
const calls = [];

const ACCOUNTS = { accounts: [{ id: 'acc-1', account_number: '5010000001', balance_minor: 500000, available_minor: 500000, currency: 'GHS' }] };
const PROFILE = {
  entity: 'personal', mustChangePin: process.argv[3] === 'nopin',
  accounts: [{ name: 'Current account', num: '5010000001', accountNumber: '5010000001', balance: 5000, type: 'current', currency: 'GHS', card: null, virtualCards: [], payroll: [] }],
  transactions: [], goals: [], beneficiaries: []
};

const store = { 'adb.session': JSON.stringify({ accessToken: 'tok', subject: { full_name: 'Test Person' } }) };

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://pokzbank.org/' + file,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(w, 'localStorage', {
      value: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } }
    });
    w.fetch = (url, opts = {}) => {
      const u = String(url);
      calls.push(`${opts.method || 'GET'} ${u.replace('https://pokzbank.org', '')}`);
      const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (u.includes('/api/health')) return ok({ status: 'ok' });
      if (u.includes('/api/v1/accounts')) return ok(ACCOUNTS);
      if (u.includes('/api/accounts/')) return ok(PROFILE);
      if (u.includes('/api/v1/payments/name-enquiry')) return ok({ name: 'Kojo Mensah', bank: 'Digital Bank', branch: 'Digital — no branch', accountNumber: '5010000002', self: false });
      if (u.includes('/api/v1/payments/banks')) return ok({ banks: [{ code: '300303', name: 'GCB Bank' }] });
      if (u.includes('/api/transactions')) return ok({ tx: { id: 't1', status: 'Completed', amount: -50, merchant: 'Kojo Mensah', ref: 'ADB1' }, balance: 4950 });
      if (u.includes('/api/otp/request')) return ok({ challengeId: 'ch1', demoCode: '123456' });
      if (u.includes('/api/otp/verify')) return ok({ stepUpToken: 'st1' });
      return ok({});
    };
    w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
    w.onerror = (m) => errors.push(String(m));
  }
});

const w = dom.window;
const d = w.document;
const sheetText = () => (d.getElementById('sheet')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
const click = (sel) => { const el = d.querySelector(sel); if (!el) return false; el.click(); return true; };

setTimeout(async () => {
  console.log(`${file}`);
  console.log('  boot errors     :', errors.length ? errors.slice(0, 2).join(' | ') : 'none');

  try { w.eval('sendPickSheet()'); } catch (e) { console.log('  sendPickSheet   : THREW', e.message); }
  console.log('  step 1 sheet    :', sheetText());

  console.log('  tap Digital Bank:', click('[data-act="send-internal"]'));
  await new Promise((r) => setTimeout(r, 60));
  console.log('  step 2 sheet    :', sheetText());

  console.log('  tap someone else:', click('[data-act="send-other"]'));
  await new Promise((r) => setTimeout(r, 120));
  console.log('  step 3 sheet    :', sheetText());

  const to = d.getElementById('sdTo');
  if (to) to.value = '5010000002';
  console.log('  tap check name  :', click('[data-act="send-lookup"]'));
  await new Promise((r) => setTimeout(r, 200));
  console.log('  confirm sheet   :', sheetText());

  const amt = d.getElementById('sdAmt');
  if (amt) amt.value = '50';
  console.log('  tap send        :', click('[data-act="send-go"]'));
  await new Promise((r) => setTimeout(r, 250));
  console.log('  after send      :', sheetText());
  console.log('  PIN prompt?     :', /PIN|pin/.test(sheetText()));
  console.log('  errors          :', errors.length ? errors.slice(0, 3).join(' | ') : 'none');
  // type the PIN and finish
  for (const digit of ['1','2','3','4']) {
    const k = d.querySelector(`[data-key="${digit}"]`);
    if (k) k.dispatchEvent(new w.PointerEvent('pointerdown', {bubbles:true}));
  }
  await new Promise((r) => setTimeout(r, 400));
  console.log('  after PIN       :', sheetText());
  console.log('  commit called   :', calls.some((c) => c.includes('POST /api/transactions')));
  console.log('  errors          :', errors.length ? errors.slice(0, 3).join(' | ') : 'none');
  console.log('  calls           :', calls.filter((c) => !c.includes('health')).slice(-4).join(', '));
  w.close();
  process.exit(0);
}, 900);
