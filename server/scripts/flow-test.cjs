/**
 * Browser-side flow tests.
 *
 * The server suite has never been the weak half. Everything that reached a
 * customer broken this week broke in the browser, where a thrown error goes to
 * a console nobody is watching. These drive the real pages in a real DOM and
 * fail loudly on anything uncaught.
 */
const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');

let pass = 0; let fail = 0;
const ok = (m) => { pass += 1; console.log('  ✓', m); };
const bad = (m, got) => { fail += 1; console.log('  ✗', m, '—', got); };

const ACCOUNTS = { accounts: [{ id: 'acc-1', account_number: '5010000001', balance_minor: 500000, available_minor: 500000, currency: 'GHS', mambu_account_key: 'abc123' }] };
const CARD = { num: '•••• •••• •••• 4242', fullNum: '4000 0012 3456 4242', cvv: '123', exp: '09/29', frozen: false, tier: 'platinum', scheme: 'VISA' };
const PROFILE = (mustChangePin = false) => ({
  entity: 'personal', mustChangePin,
  accounts: [{ name: 'Current account', num: '5010000001', accountNumber: '5010000001', balance: 5000, type: 'current', currency: 'GHS', card: CARD, virtualCards: [], payroll: [], mambuRef: 'abc123' }],
  transactions: [
    { id: 't1', ts: Date.now(), merchant: 'Melcom Osu', amount: -45.5, category: 'Shopping', method: 'Card', status: 'Completed', ref: 'ADB1' },
    { id: 't2', ts: Date.now(), merchant: 'Kwame', amount: -20, category: 'Transfer', method: 'Mobile money', status: 'Completed', ref: 'ADB2' }
  ],
  goals: [{ id: 'g1', name: 'Emergency fund', icon: 'shield', due: 'open', target: 20000, saved: 5000, monthly: 800 }],
  beneficiaries: [{ name: 'Kojo Mensah', bank: 'MoMo', acct: '0241234567', last: 'GHS 200' }]
});

function boot(file, { mustChangePin = false } = {}) {
  const html = fs.readFileSync('/home/claude/repo/' + file, 'utf8');
  const errors = [];
  const calls = [];
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
        const send = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        if (u.includes('/api/health')) return send({ status: 'ok' });
        if (u.includes('/api/v1/accounts')) return send(ACCOUNTS);
        if (u.includes('/api/accounts/')) return send(PROFILE(mustChangePin));
        if (u.includes('/api/v1/invest/assets')) return send({ assets: [{ symbol: 'BTC', name: 'Bitcoin', priceMinor: 145000000, changePct: 1.4 }], feeBps: 75 });
        if (u.includes('/api/v1/invest/portfolio')) return send({ holdings: [{ symbol: 'BTC', name: 'Bitcoin', units: 0.001, pledgedUnits: 0, freeUnits: 0.001, priceMinor: 145000000, valueMinor: 145000, costMinor: 140000, gainMinor: 5000 }], valueMinor: 145000, gainMinor: 5000, loans: [], borrowedMinor: 0, orders: [] });
        if (u.includes('/api/v1/invest/')) return send({ symbol: 'BTC', units: 0.0001, reference: 'INV1' });
        if (u.includes('/api/v1/cards/linked')) return send({ cards: [{ id: 'lc1', scheme: 'visa', last4: '1111', expiry: '09/29', issuer: 'GCB Bank', isDefault: true }] });
        if (u.includes('/api/v1/cards/tiers')) return send({ tiers: {} });
        if (u.includes('/api/v1/qr/decode')) return send({ merchant: { name: 'Melcom Osu', city: 'Accra', terminalId: 'TILL03' }, dynamic: true, amountMinor: 4550, needsAmount: false });
        if (u.includes('/api/v1/qr/pay')) return send({ paid: true, reference: 'QR1', merchant: 'Melcom Osu', amountMinor: 4550 });
        if (u.includes('/api/v1/payments/name-enquiry')) return send({ name: 'Kojo Mensah', bank: 'Digital Bank', branch: 'Digital — no branch', accountNumber: '5010000002', self: false });
        if (u.includes('/api/v1/payments/banks')) return send({ banks: [{ code: '300303', name: 'GCB Bank' }] });
        if (u.includes('/api/v1/payments/deposits')) return send({ transaction: { status: 'processing' } });
        if (u.includes('/api/transactions')) return send({ tx: { id: 't9', status: 'Completed', amount: -50, merchant: 'Kojo Mensah', ref: 'ADB9' }, balance: 4950 });
        if (u.includes('/api/otp/request')) return send({ challengeId: 'ch1', demoCode: '123456' });
        if (u.includes('/api/otp/verify')) return send({ stepUpToken: 'st1' });
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
  console.log(`\n── ${file}`);
  const { w, d, errors, calls } = boot(file);
  await wait(700);

  const sheet = () => (d.getElementById('sheet')?.textContent || '').replace(/\s+/g, ' ').trim();
  const tap = (sel) => { const el = d.querySelector(sel); if (el) { el.click(); return true; } return false; };
  const run1 = (code) => { try { w.eval(code); return true; } catch (e) { bad(code, e.message); return false; } };

  errors.length ? bad('boots clean', errors[0]) : ok('boots clean');

  /* The app tracks the open screen as S.tab, online banking as S.view. Setting
     the wrong one silently renders the previous screen, which is how this test
     first reported passes it had not earned. */
  const nav = (name) => `S.tab='${name}'; S.view='${name}'; render();`;
  const screens = file === 'app.html'
    ? ['home', 'save', 'invest', 'cards', 'you']
    : ['overview', 'save', 'invest', 'cards', 'statements'];

  for (const tab of screens) {
    if (!('V' in w)) break;
    try {
      w.eval(nav(tab));
      const body = d.getElementById('view')?.innerHTML || d.getElementById('scroll')?.innerHTML || '';
      body.length > 200 ? ok(`${tab} renders`) : bad(`${tab} renders`, `${body.length} chars`);
    } catch (e) { bad(`${tab} renders`, e.message); }
  }

  // invest must show the assets, not the savings screen
  if ('vInvest' in w) {
    w.eval(nav('invest'));
    const html = d.getElementById('scroll')?.innerHTML || d.body.innerHTML;
    /Digital assets/.test(html) ? ok('invest shows digital assets') : bad('invest shows digital assets', 'not found');
    /Bitcoin/.test(html) ? ok('asset prices render') : bad('asset prices render', 'not found');
  }

  // cards must show card spending only
  if ('vCards' in w) {
    w.eval(nav('cards'));
    const html = d.getElementById('scroll')?.innerHTML || d.body.innerHTML;
    /Melcom Osu/.test(html) ? ok('card spending listed') : bad('card spending listed', 'missing');
    !/Kwame/.test(html.split('On this card')[1] || '') ? ok('wallet transfers excluded') : bad('wallet transfers excluded', 'mobile money leaked in');
    /PLATINUM|Platinum/.test(html) ? ok('card tier on the face') : bad('card tier', 'missing');
    /1111/.test(html) ? ok('linked card listed') : bad('linked card listed', 'missing');
  }

  // sheets that must open without throwing
  const sheets = [
    ['sendPickSheet()', 'Where is it going'],
    ['topUpSheet()', 'Add money'],
    ['scanSheet()', 'Scan to pay'],
    ['linkCardSheet()', 'Link a card'],
    ['verifySheet()', 'Verify your identity'],
    ['businessSheet()', 'business account'],
    ['walletToBankSheet()', 'Wallet to bank']
  ];
  for (const [call, expect] of sheets) {
    const name = call.replace(/\(.*/, '');
    if (!(name in w)) { bad(`${name} exists`, 'not defined'); continue; }
    if (!run1(call)) continue;
    await wait(60);
    sheet().includes(expect) ? ok(`${name} opens`) : bad(`${name} opens`, sheet().slice(0, 50));
  }

  // the full send journey, through the PIN
  run1('sendPickSheet()');
  tap('[data-act="send-internal"]'); await wait(50);
  tap('[data-act="send-other"]'); await wait(120);
  const to = d.getElementById('sdTo'); if (to) to.value = '5010000002';
  tap('[data-act="send-lookup"]'); await wait(200);
  sheet().includes('Kojo Mensah') ? ok('name enquiry shows the holder') : bad('name enquiry', sheet().slice(0, 50));
  const amt = d.getElementById('sdAmt'); if (amt) amt.value = '50';
  tap('[data-act="send-go"]'); await wait(200);
  /PIN/i.test(sheet()) ? ok('send asks for the PIN') : bad('send asks for the PIN', sheet().slice(0, 60));

  // QR pay
  if ('qrDecode' in w) {
    run1("qrDecode('00020101021226300012GH.GHIPSS.QR0109GH0012345520459995303936540645.505802GH5910Melcom Osu6005Accra62110207TILL0363041234')");
    await wait(200);
    sheet().includes('Melcom Osu') ? ok('QR decodes to the merchant') : bad('QR decode', sheet().slice(0, 50));
  }

  errors.length ? bad('no uncaught errors during the run', errors.slice(0, 2).join(' | ')) : ok('no uncaught errors during the run');
  w.close();
}

(async () => {
  await run('app.html');
  await run('web.html');
  console.log(`\npassed ${pass}, failed ${fail}`);
  process.exit(fail ? 1 : 0);
})();
