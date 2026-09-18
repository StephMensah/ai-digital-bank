/* =========================================================================
   AI-DIGITAL BANK CUSTOMER CORE
   Browser port of aibank_engine.py. Every agent keeps the engine contract:
       infer(input) -> { action, confidence, explanation, adverse }
   The wrapper FID.decide() applies the confidence floor, routes adverse
   outcomes to human adjudication, and writes the customer-visible receipt
   that mirrors the engine's audit record.
   ========================================================================= */
const FID = (() => {

  const CCY = 'GHS';
  const money  = n => CCY + ' ' + Number(n).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
  const money0 = n => CCY + ' ' + Math.round(n).toLocaleString('en-GB');
  const pct    = n => (n*100).toFixed(0) + '%';

  /* deterministic pseudo-random from a string, so demos repeat exactly */
  const seed = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };

  /* ---------------------------------------------------------------- people */
  const PERSONAL = {
    id:'personal', label:'Personal', holder:'Ama Boateng', since:'2019', mustChangePin:true,
    accounts:[
      {name:'Current account', num:'•••• 3391', balance:4182.60, type:'current'},
      {name:'Target savings',   num:'•••• 7742', balance:11500.00, type:'savings'},
    ],
    card:{num:'•••• •••• •••• 3391', fullNum:'4556 0198 2231 3391', cvv:'482', exp:'09/29', frozen:false},
    virtualCards:[{num:'4821 •••• •••• 7719', fullNum:'4821 5507 4413 7719', cvv:'091', exp:'11/28', locked:'one merchant'}],
    credit:{bureau:648, dti:0.31, income:6400, thinFile:false},
    beneficiaries:[
      {name:'Kojo Mensah', bank:'AI-Digital Bank', acct:'•••• 2210', last:'GHS 200'},
      {name:'MTN MoMo 024 447 8812', bank:'MoMo', acct:'024 447 8812', last:'GHS 50'},
      {name:'Electro World Accra', bank:'GCB', acct:'•••• 9931', last:'GHS 1,240'},
      {name:'Global Marine Ltd', bank:'Correspondent · Dubai', acct:'AE07 •••• 3311', last:'first payment'},
    ],
    transactions:[
      {d:'Today 07:42', m:'Bolt Ghana', a:-38.00},
      {d:'Yesterday',   m:'Melcom Osu', a:-214.50},
      {d:'Yesterday',   m:'Salary — Ashesi University', a:6400.00},
      {d:'24 Aug',      m:'ECG prepaid', a:-150.00},
      {d:'23 Aug',      m:'Bolt Ghana', a:-42.00},
      {d:'22 Aug',      m:'Shoprite Accra Mall', a:-388.20},
      {d:'21 Aug',      m:'Bolt Ghana', a:-51.00},
    ],
  };

  const BUSINESS = {
    id:'business', label:"Ama's Kitchen Ltd", holder:"Ama's Kitchen Ltd", since:'2022', mustChangePin:true,
    accounts:[
      {name:'Business current', num:'•••• 5108', balance:38470.15, type:'current'},
      {name:'Tax reserve',      num:'•••• 5109', balance:9200.00,  type:'savings'},
    ],
    card:{num:'•••• •••• •••• 5108', fullNum:'4556 7702 1145 5108', cvv:'317', exp:'02/28', frozen:false},
    virtualCards:[{num:'4821 •••• •••• 4402', fullNum:'4821 9931 0087 4402', cvv:'650', exp:'06/28', locked:'one merchant'}],
    credit:{bureau:702, dti:0.24, income:41000, thinFile:true},
    beneficiaries:[
      {name:'Adom Poultry Farms', bank:'CalBank', acct:'•••• 8820', last:'GHS 12,400'},
      {name:'Payroll — 14 staff', bank:'AI-Digital Bank', acct:'batch', last:'GHS 18,900'},
      {name:'Global Marine Ltd', bank:'Correspondent · Dubai', acct:'AE07 •••• 3311', last:'first payment'},
    ],
    transactions:[
      {d:'Today 06:10', m:'Card settlement — 214 covers', a:12840.00},
      {d:'Yesterday',   m:'Adom Poultry Farms', a:-12400.00},
      {d:'25 Aug',      m:'Payroll — 14 staff', a:-18900.00},
      {d:'24 Aug',      m:'Card settlement — 188 covers', a:10120.00},
      {d:'23 Aug',      m:'Ghana Water', a:-640.00},
    ],
    /* 8-week net cash position, engine forecast from week 4 */
    cashflow:[42100, 38400, 44900, 38470, 31200, 22600, -4800, 9100],
  };

  const ENTITIES = { personal: PERSONAL, business: BUSINESS };

  /* -------------------------------------------------------------- language */
  const LANG = {
    English:{base:.93, writes:true}, Twi:{base:.80, writes:true},
    Ga:{base:.74, writes:false}, Ewe:{base:.72, writes:false}, Hausa:{base:.71, writes:false},
  };

  /* ----------------------------------------------------------------- floors */
  const FLOOR = { chat:0.70, fraud:0.80, loan:0.78, sanctions:0.90, doc:0.85 };

  /* ================================================================= agents */

  /* retail.fraud_detection — azureml://aidigitalbank/retail-fraud-lgbm/v3 */
  function assessPayment(tx){
    const s = seed(tx.to + tx.amount);
    const foreign = /Dubai|Correspondent|AE07/.test(tx.bankLine || '');
    const night = tx.hour < 5;
    const unseen = tx.newBeneficiary === true;
    let score = 0.05 + 0.35*foreign + 0.20*night + 0.18*unseen + Math.min(0.35, tx.amount/60000) + (s-0.5)*0.08;
    score = Math.max(0, Math.min(0.98, score));
    const reasons = [];
    if (foreign) reasons.push('first payment to a correspondent bank outside Ghana');
    if (night) reasons.push('sent outside your usual hours');
    if (unseen) reasons.push('beneficiary added today');
    if (tx.amount > 5000) reasons.push(`amount ${money0(tx.amount)} above your 90-day average`);
    if (!reasons.length) reasons.push('matches your usual pattern for this beneficiary');
    return score > 0.42
      ? {action:'STEP_UP', confidence:0.62 + score/3, explanation:reasons.join('; '), adverse:false, reasons}
      : {action:'APPROVE', confidence:0.96 - score/2, explanation:reasons.join('; '), adverse:false, reasons};
  }

  /* fcc.sanctions — lexisnexis://bridger/screen/v1 */
  const WATCH = ['global marine', 'oceanic freight', 'transcontinental holdings'];
  function screenBeneficiary(name){
    const hit = WATCH.find(w => name.toLowerCase().includes(w));
    if (hit){
      const sim = 0.62 + seed(name)*0.2;
      return {action:'HOLD_FOR_L2_REVIEW', confidence:0.55 + sim,
        explanation:`name similarity ${sim.toFixed(2)} against a sanctions and PEP watchlist entry`,
        adverse:false, similarity:sim};
    }
    const sim = seed(name) * 0.24;
    return {action:'CLEAR', confidence:0.96,
      explanation:`no match above 0.30 (closest ${sim.toFixed(2)})`, adverse:false, similarity:sim};
  }

  /* retail.loan_preapproval / credit.scoring — datarobot://aidigitalbank/thin-file-scorecard/v5 */
  function preapprove(amount, profile){
    const pd = Math.max(0.01, Math.min(0.9, (750 - profile.bureau)/900 + profile.dti/3));
    const cap = profile.income * 4;
    const limit = Math.round((1 - pd) * cap / 100) * 100;
    const conf = (profile.thinFile ? 0.82 : 0.94) - pd/2;
    if (pd > 0.28)
      return {action:'DECLINE', confidence:0.70, adverse:true, pd, cap, limit:0,
        explanation:`modelled default probability ${(pd*100).toFixed(1)}% is above appetite`};
    if (amount > limit)
      return {action:'ABOVE_LIMIT', confidence:conf, adverse:true, pd, cap, limit,
        explanation:`requested ${money0(amount)} exceeds the affordability cap of ${money0(limit)}`};
    return {action:'PRE_APPROVE', confidence:conf, adverse:false, pd, cap, limit,
      explanation:`default probability ${(pd*100).toFixed(1)}%, capped at 4× monthly income`};
  }

  /* retail.chatbot — rasa://aidigitalbank/multilingual-nlu/v4 */
  const INTENTS = [
    [/balance|how much|sika|akonta|ahe/i, 'balance_enquiry'],
    [/card|block|freeze|lost|stolen/i, 'card_block'],
    [/branch|atm|where|near|baabi/i, 'branch_locator'],
    [/loan|borrow|credit|bosea/i, 'loan_enquiry'],
    [/complain|wrong|twice|charge|refund|angry/i, 'complaint'],
    [/airtime|top ?up|data|bundle/i, 'airtime_topup'],
    [/statement|transactions|history/i, 'statement'],
    [/cash ?flow|forecast|working capital|invoice/i, 'cashflow'],
  ];
  function parse(text, lang){
    const hit = INTENTS.find(([re]) => re.test(text));
    const intent = hit ? hit[1] : 'unknown';
    let conf = LANG[lang].base - 0.15 + seed(text)*0.24;
    if (intent === 'unknown') conf -= 0.19;
    conf = Math.max(0.18, Math.min(0.99, conf));
    return {action: intent === 'unknown' ? 'CLARIFY' : 'SERVE_' + intent.toUpperCase(),
      confidence:conf, intent, adverse:false,
      explanation:`intent=${intent}, language=${lang}`};
  }

  /* sme.cashflow — prophet://aidigitalbank/sme-cashflow/v1 */
  function forecastCashflow(entity){
    const s = entity.cashflow || [];
    if (!s.length) return {action:'NO_DATA', confidence:0, adverse:false, trough:0, week:0,
      explanation:'no settlement history on this account yet'};
    const trough = Math.min(...s.slice(4));
    const week = s.indexOf(trough) - 3;
    return {action: trough < 0 ? 'OFFER_WORKING_CAPITAL' : 'NO_ACTION',
      confidence:0.78, adverse:false, trough, week,
      explanation: trough < 0
        ? `projected shortfall of ${money0(Math.abs(trough))} in week ${week}, driven by payroll landing before card settlement`
        : 'no financing gap projected over eight weeks'};
  }

  /* sme.doc_verification — tesseract+layoutlm://aidigitalbank/lpo-verify/v2 */
  function verifyDocument(filename){
    /* a PDF purchase order or a plain photo (a cheque, say) both read fine; the filename hints
       that mark a bad scan — blur, a placeholder scan0, or an explicit "photo" caveat — are what
       actually knocks quality down, not the file type itself */
    const legible = /\.(pdf|jpe?g|png)$/i.test(filename) && !/blur|scan0|photo/i.test(filename);
    const q = legible ? 0.55 + seed(filename)*0.40 : seed(filename)*0.29;
    if (q < 0.30)
      return {action:'REJECT_RESUBMIT', confidence:0.55 + q, adverse:false, quality:q,
        explanation:`scan quality ${q.toFixed(2)} below the OCR threshold — buyer name and amount could not be read`};
    return {action:'VERIFIED', confidence:0.80 + q*0.18, adverse:false, quality:q,
      explanation:'buyer, amount and delivery date matched against the purchase order registry'};
  }

  /* ops.categorisation — supporting the spending insight */
  const CATS = [[/bolt|uber|yango|trotro/i,'Transport'],[/melcom|shoprite|market|palace/i,'Groceries'],
                [/ecg|water|dstv|surfline/i,'Utilities'],[/salary|settlement/i,'Income'],
                [/poultry|payroll|supplier/i,'Cost of sales']];
  const categorise = m => (CATS.find(([re]) => re.test(m)) || [null,'Other'])[1];

  /* ================================================== decision + receipts */
  const ledger = [];
  const subs = [];
  const onDecision = fn => subs.push(fn);

  function decide(useCase, result, opts = {}){
    const floor = opts.floor ?? 0.75;
    const review = result.confidence < floor || result.adverse === true;
    const rec = {
      ts: new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
      useCase, action: review && result.adverse ? 'HUMAN_ADJUDICATION' : result.action,
      confidence: result.confidence, explanation: result.explanation,
      review, ref: opts.ref || ('DEC-' + (4400 + ledger.length)),
      hash: '0x' + Math.floor(seed(useCase + result.explanation + ledger.length) * 0xfffffff)
              .toString(16).padStart(7,'0'),
      title: opts.title || useCase,
    };
    ledger.unshift(rec);
    sync(rec, {customer: opts.customer, channel: opts.channel, amount: opts.amount,
               evidence: opts.evidence});
    subs.forEach(f => f(rec));
    return {...result, review, record: rec};
  }

  /* When served by decision_api.py, every decision goes to the shared spine: the audit log
     the control tower reads, and — if a person is needed — the reviewer's queue. Opened as a
     bare file the products still work; they just decide alone. */
  const API = (typeof location !== 'undefined' && location.protocol.startsWith('http')) ? '' : null;
  let apiUp = API !== null;

  /* ---- session -------------------------------------------------------------------------
     The Node API authorises by bearer token, not by the entity id in the request body, so
     the id below only selects which of the signed-in customer's accounts to act on. Opened
     as a bare file, or before anyone signs in, everything falls back to the bundled demo
     data exactly as it did before. */
  const STORE = 'adb.session';
  let session = (() => {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
  })();
  const signedIn = () => Boolean(session && session.accessToken);
  function keepSession(next){
    session = next;
    try { next ? localStorage.setItem(STORE, JSON.stringify(next)) : localStorage.removeItem(STORE); }
    catch { /* private browsing — the session simply does not outlive the tab */ }
  }
  const authHeaders = () =>
    signedIn() ? {Authorization: 'Bearer ' + session.accessToken} : {};

  async function signIn(msisdn, password){
    const res = await fetch(API + '/api/v1/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({msisdn, password})
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.message || 'Could not sign you in'),
      {code: json.code || 'sign_in_failed'});
    const tokens = json.tokens || json;
    keepSession({accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, subject: json.customer});
    return json.customer;
  }
  const signOut = () => keepSession(null);
  function sync(rec, extra){
    if (!apiUp) return;
    fetch(API + '/api/decisions', {method:'POST',
      headers:{'Content-Type':'application/json', ...authHeaders()},
      body: JSON.stringify({...rec, ...extra})}).catch(() => { apiUp = false; });
  }

  /* ---- pin + otp: the real authorization gate in front of every transaction -------------
     Unlike sync() above, none of this tolerates the API being down — a payment cannot be
     authorized without the server that holds the PIN hash and the account balance, so every
     call here throws with `.code` set (offline, pin_change_required, invalid_pin,
     invalid_step_up, insufficient_funds, ...) for the caller to route to the right sheet. */
  async function apiCall(path, body){
    if (!apiUp) throw Object.assign(new Error('offline'), {code:'offline'});
    let res;
    if (!signedIn()) throw Object.assign(new Error('sign in required'), {code:'signed_out'});
    try { res = await fetch(API + path, {method:'POST',
      headers:{'Content-Type':'application/json', ...authHeaders()},
      body: JSON.stringify(body || {})}); }
    catch (e) { throw Object.assign(new Error('offline'), {code:'offline'}); }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || 'request failed'),
      {code: json.error || 'request_failed', status: res.status});
    return json;
  }
  async function fetchAccount(customerId){
    if (!apiUp) throw Object.assign(new Error('offline'), {code:'offline'});
    let res;
    if (!signedIn()) throw Object.assign(new Error('sign in required'), {code:'signed_out'});
    try { res = await fetch(API + '/api/accounts/' + customerId, {headers: authHeaders()}); }
    catch (e) { throw Object.assign(new Error('offline'), {code:'offline'}); }
    if (res.status === 401) { signOut(); throw Object.assign(new Error('sign in required'), {code:'signed_out'}); }
    if (!res.ok) throw Object.assign(new Error('offline'), {code:'offline'});
    return res.json();
  }
  const requestOtp = (customerId, purpose) => apiCall('/api/otp/request', {customerId, purpose});
  const verifyOtp = (challengeId, code) => apiCall('/api/otp/verify', {challengeId, code});
  const setPin = (customerId, currentPin, newPin, stepUpToken) =>
    apiCall('/api/pin/set', {customerId, currentPin, newPin, stepUpToken});
  /* proof-of-you for a sensitive action that doesn't move money (reveal card details, raise a
     limit) — same PIN + step-up-token check as a payment, no transaction written */
  const verifyPinOnly = (customerId, pin, stepUpToken) =>
    apiCall('/api/pin/verify', {customerId, pin, stepUpToken});
  const commitTransaction = (customerId, payload) =>
    apiCall('/api/transactions', {customerId, ...payload});
  /* not a payment — no PIN/OTP — but still has to be known server-side, or nothing could ever
     deposit into or transfer out of it afterwards */
  const openAccount = (customerId, name, type) =>
    apiCall('/api/accounts/open', {customerId, name, type});

  /* receipt markup, shared by both products */
  function slip(title, pairs, footer){
    return `<div class="slip"><div class="slip-hd">${title}</div><dl>` +
      pairs.map(([k,v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') +
      `</dl><div class="slip-ft">${footer}</div></div>`;
  }

  /* tiny SVG column chart for cash-flow */
  function columns(values, opts = {}){
    if (!values || !values.length) return '';
    const w = opts.w || 460, h = opts.h || 130, n = values.length, bw = w/n;
    const max = Math.max(...values.map(Math.abs)) * 1.15;
    const zero = h/2 + 10;
    const scale = v => (v/max) * (h/2);
    let s = `<svg viewBox="0 0 ${w} ${h+28}" class="cols" role="img" aria-label="Cash position by week">`;
    s += `<line x1="0" y1="${zero}" x2="${w}" y2="${zero}" stroke="var(--hair)"/>`;
    values.forEach((v,i) => {
      const x = i*bw + bw*0.2, bwid = bw*0.6, hgt = Math.abs(scale(v));
      const y = v >= 0 ? zero - hgt : zero;
      const fill = v < 0 ? 'var(--alert)' : (i >= (opts.forecastFrom ?? n) ? 'var(--orange)' : 'var(--ink)');
      const op = i >= (opts.forecastFrom ?? n) ? '1' : '.82';
      s += `<rect x="${x}" y="${y}" width="${bwid}" height="${Math.max(hgt,2)}" fill="${fill}" opacity="${op}"/>`;
      s += `<text x="${x+bwid/2}" y="${h+20}" text-anchor="middle" class="colslab">${opts.labels?.[i] ?? ('w'+(i+1))}</text>`;
    });
    return s + '</svg>';
  }

  return { CCY, money, money0, pct, seed, ENTITIES, LANG, FLOOR, get live(){ return apiUp; },
           signIn, signOut, get signedIn(){ return signedIn(); },
           get customer(){ return session && session.subject; },
           assessPayment, screenBeneficiary, preapprove, parse,
           forecastCashflow, verifyDocument, categorise,
           ledger, onDecision, decide, slip, columns,
           fetchAccount, requestOtp, verifyOtp, setPin, verifyPinOnly, commitTransaction, openAccount };
})();

/* =========================================================================
   DIGITAL BANK EXTENSION
   Everything a branch used to do, expressed as data and agents the products
   can call. Same contract as before: infer(input) -> {action, confidence,
   explanation, adverse}.
   ========================================================================= */
Object.assign(FID, (() => {

  const BILLERS = [
    {id:'ecg',    name:'ECG Prepaid',        cat:'Utilities',  hint:'Meter number',   icon:'power'},
    {id:'gwcl',   name:'Ghana Water',        cat:'Utilities',  hint:'Account number', icon:'water'},
    {id:'dstv',   name:'DStv / GOtv',        cat:'TV',         hint:'Smartcard',      icon:'tv'},
    {id:'surf',   name:'Surfline / Busy',    cat:'Internet',   hint:'Account number', icon:'wifi'},
    {id:'school', name:'School fees',        cat:'Education',  hint:'Student ID',     icon:'school'},
    {id:'ssnit',  name:'SSNIT contributions',cat:'Statutory',  hint:'Employer number',icon:'gov'},
    {id:'gra',    name:'GRA tax payment',    cat:'Statutory',  hint:'TIN',            icon:'invoice'},
    {id:'insure', name:'Insurance premium',  cat:'Insurance',  hint:'Policy number',  icon:'shield'},
  ];

  const NETWORKS = [
    {id:'mtn',  name:'MTN',        colour:'#FFCC00'},
    {id:'telec',name:'Telecel',    colour:'#E4002B'},
    {id:'at',   name:'AT',         colour:'#0057B8'},
  ];

  /* indicative, refreshed hourly in production from treasury */
  const FX = {
    USD:{buy:11.82, sell:12.14, name:'US Dollar'},
    GBP:{buy:14.90, sell:15.35, name:'Pound Sterling'},
    EUR:{buy:12.71, sell:13.08, name:'Euro'},
    NGN:{buy:0.0072, sell:0.0079, name:'Naira'},
  };

  const TBILLS = [
    {tenor:91,  rate:0.2685, label:'91-day'},
    {tenor:182, rate:0.2810, label:'182-day'},
    {tenor:364, rate:0.2925, label:'364-day'},
  ];

  const DEPOSITS = [
    {months:3,  rate:0.185}, {months:6, rate:0.205}, {months:12, rate:0.235},
  ];

  const GOALS = [
    {id:'g1', name:'Rent — Dansoman',  target:14400, saved:9600,  monthly:1200, due:'Mar 2027', icon:'home'},
    {id:'g2', name:'Emergency fund',   target:20000, saved:4350,  monthly:500,  due:'open',     icon:'shield'},
    {id:'g3', name:'Kofi — school fees',target:6000, saved:5400,  monthly:600,  due:'Jan 2027', icon:'school'},
  ];

  const STANDING = [
    {name:'Rent — Mensah Properties', amount:1200, when:'1st of each month', next:'1 Sep'},
    {name:'Emergency fund transfer',  amount:500,  when:'28th of each month',next:'28 Aug'},
    {name:'DStv Compact',             amount:390,  when:'5th of each month', next:'5 Sep'},
  ];

  const KYC = {tier:2, label:'Tier 2', dailyLimit:20000, singleLimit:10000,
               toTier3:['Ghana Card verified','Proof of address','Income declaration']};

  const BRANCHES = [
    {name:'Ridge branch',        area:'Ridge',        address:'12 Liberation Rd, Ridge',        hours:'Mon–Fri 8:30–16:00, Sat 9:00–13:00', atm:false, services:['Teller','Forex','Safe deposit']},
    {name:'Osu branch',          area:'Osu',          address:'Oxford St, Osu',                  hours:'Mon–Fri 8:30–16:00',                 atm:false, services:['Teller','Business banking']},
    {name:'Airport City branch', area:'Airport City', address:'Airport City, near Marina Mall',   hours:'Mon–Fri 8:30–17:00, Sat 9:00–13:00', atm:false, services:['Teller','Forex','Premier banking']},
    {name:'Ridge ATM',           area:'Ridge',        address:'12 Liberation Rd, Ridge',          hours:'24 hours',                            atm:true,  services:['Cash withdrawal','Balance enquiry']},
    {name:'Accra Mall ATM',      area:'Spintex',      address:'Accra Mall, Spintex Rd',            hours:'24 hours',                            atm:true,  services:['Cash withdrawal','Cash deposit']},
    {name:'Osu Oxford St ATM',   area:'Osu',          address:'Oxford St, near Republic Bar',      hours:'24 hours',                            atm:true,  services:['Cash withdrawal']},
    {name:'Dansoman branch',     area:'Dansoman',     address:'High St, Dansoman',                 hours:'Mon–Fri 8:30–16:00',                 atm:false, services:['Teller']},
    {name:'Tema branch',         area:'Tema',         address:'Community 1, Tema',                 hours:'Mon–Fri 8:30–16:00, Sat 9:00–13:00', atm:false, services:['Teller','Business banking']},
  ];

  const DEVICES = [
    {name:'iPhone 15 — Safari',        location:'Accra, Ghana',   lastActive:'Active now',    current:true},
    {name:'Windows PC — Chrome',       location:'Accra, Ghana',   lastActive:'2 days ago',    current:false},
    {name:'Samsung Galaxy A54 — App',  location:'Kumasi, Ghana',  lastActive:'11 days ago',   current:false},
  ];

  /* ---- agents ---------------------------------------------------------- */

  /* treasury.fx — quote with the spread made explicit */
  function fxQuote(amount, ccy, side){
    const r = FX[ccy], rate = side === 'buy' ? r.sell : r.buy;   // bank sells to you at 'sell'
    const cedis = side === 'buy' ? amount * rate : amount * rate;
    const midRate = (r.buy + r.sell) / 2;
    const spread = Math.abs(rate - midRate) * amount;
    return {action:'QUOTE', confidence:0.99, adverse:false, rate, cedis, spread,
      explanation:`${side === 'buy' ? 'You buy' : 'You sell'} ${ccy} at ${rate.toFixed(4)}; ` +
                  `mid-market is ${midRate.toFixed(4)}, so our margin on this trade is ${money0(spread)}`};
  }

  /* investments.tbill — Bank of Ghana auction, net of the 8% withholding tax */
  function tbillQuote(amount, tenor){
    const t = TBILLS.find(x => x.tenor === tenor);
    const gross = amount * t.rate * (tenor / 364);
    const tax = gross * 0.08;
    return {action:'QUOTE', confidence:0.98, adverse:false,
      gross, tax, net:gross - tax, maturity:amount + gross - tax, rate:t.rate,
      explanation:`${(t.rate*100).toFixed(2)}% for ${tenor} days on ${money0(amount)}; ` +
                  `${money0(gross)} interest less ${money0(tax)} withholding tax`};
  }

  /* savings.goal — will this goal land on time at the current rate? */
  function goalProject(g){
    const left = g.target - g.saved;
    const months = Math.ceil(left / g.monthly);
    const onTrack = g.due === 'open' || months <= 6;
    return {action: onTrack ? 'ON_TRACK' : 'BEHIND', confidence:0.84, adverse:false, months, left,
      explanation: left <= 0 ? 'goal reached'
        : `${money0(left)} to go; ${months} more month${months>1?'s':''} at ${money0(g.monthly)}`};
  }

  /* ops.payroll — maker-checker with a screen on every payee */
  function payrollCheck(batch){
    const flagged = batch.filter(p => FID.screenBeneficiary(p.name).action !== 'CLEAR');
    const total = batch.reduce((s,p) => s + p.amount, 0);
    return {action: flagged.length ? 'HOLD_BATCH' : 'READY_FOR_APPROVAL',
      confidence: flagged.length ? 0.64 : 0.93, adverse:false, flagged, total,
      explanation: flagged.length
        ? `${flagged.length} of ${batch.length} payees matched a watchlist entry; batch cannot be released`
        : `${batch.length} payees, ${money0(total)}, all screened clear — needs a second approver`};
  }

  /* limits.check — Bank of Ghana KYC tiering, before anything else runs */
  function limitCheck(amount){
    if (amount > KYC.singleLimit)
      return {action:'BLOCKED_BY_TIER', confidence:1, adverse:true,
        explanation:`${money0(amount)} is over your ${KYC.label} single-transaction limit of ${money0(KYC.singleLimit)}`};
    return {action:'WITHIN_LIMIT', confidence:1, adverse:false,
      explanation:`within your ${KYC.label} limits`};
  }

  const money0 = n => 'GHS ' + Math.round(n).toLocaleString('en-GB');

  const PAYROLL = [
    {name:'Kojo Mensah', role:'Head chef', amount:3200},
    {name:'Adjoa Nyarko', role:'Sous chef', amount:2400},
    {name:'Yaw Darko', role:'Server', amount:1400},
    {name:'Efua Sarpong', role:'Server', amount:1400},
    {name:'Global Marine Ltd', role:'Contract cleaning', amount:2100},
    {name:'Akosua Frimpong', role:'Kitchen porter', amount:1200},
  ];

  return {BILLERS, NETWORKS, FX, TBILLS, DEPOSITS, GOALS, STANDING, KYC, PAYROLL, BRANCHES, DEVICES,
          fxQuote, tbillQuote, goalProject, payrollCheck, limitCheck};
})());

/* =========================================================================
   MERCHANTS, LEDGER AND FUNDING
   A statement is only readable if you can recognise a row at a glance, which
   is what a logo does. Real brand assets are licensed, so each merchant here
   carries a `logo` field that is null by default and a generated brand tile
   as the fallback. Drop a URL or an inline SVG into `logo` and the tile is
   replaced with it — nothing else has to change.
   ========================================================================= */
Object.assign(FID, (() => {

  const slugify = n => n.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const M = (match, label, colour, mark, cat, slug = null) =>
    ({match, label, colour, mark, cat, slug: slug || slugify(label)});

  const MERCHANTS = [
    M(/bolt/i,            'Bolt',                '#34D186', 'BO', 'Transport'),
    M(/uber/i,            'Uber',                '#4A5058', 'UB', 'Transport'),
    M(/yango/i,           'Yango',               '#FF3D00', 'YA', 'Transport'),
    M(/trotro|stc/i,      'STC',                 '#0B6E4F', 'ST', 'Transport'),
    M(/melcom/i,          'Melcom',              '#E4002B', 'ME', 'Shopping'),
    M(/shoprite/i,        'Shoprite',            '#E31E24', 'SH', 'Groceries'),
    M(/palace|maxmart/i,  'Palace Mall',         '#7A3E9D', 'PA', 'Groceries'),
    M(/jumia/i,           'Jumia',               '#F68B1E', 'JU', 'Shopping'),
    M(/kfc/i,             'KFC',                 '#A3080C', 'KF', 'Eating out'),
    M(/papaye/i,          'Papaye',              '#D42027', 'PP', 'Eating out'),
    M(/ecg|electricity/i, 'ECG',                 '#F5A623', 'EC', 'Utilities'),
    M(/ghana water|gwcl/i,'Ghana Water',         '#0A7CC1', 'GW', 'Utilities'),
    M(/dstv|gotv/i,       'DStv',                '#0D5AA7', 'DS', 'TV'),
    M(/surfline|busy/i,   'Surfline',            '#00A9E0', 'SU', 'Internet'),
    M(/mtn|momo/i,        'MTN',                 '#FFCB05', 'MT', 'Airtime', null),
    M(/telecel|vodafone/i,'Telecel',             '#E4002B', 'TC', 'Airtime'),
    M(/airteltigo|\bat\b/i,'AT',                 '#0057B8', 'AT', 'Airtime'),
    M(/ashesi|university/i,'Ashesi University',  '#8C1D40', 'AU', 'Income'),
    M(/adom poultry/i,    'Adom Poultry Farms',  '#5E8C31', 'AP', 'Cost of sales'),
    M(/coastal foods/i,   'Coastal Foods Ltd',   '#0E6BA8', 'CF', 'Income'),
    M(/ridge hotel/i,     'Ridge Hotel',         '#8A6D3B', 'RH', 'Income'),
    M(/global marine/i,   'Global Marine Ltd',   '#455A64', 'GM', 'Transfer'),
    M(/payroll/i,         'Payroll',             '#37474F', 'PR', 'Salaries'),
    M(/gra|tax/i,         'GRA',                 '#006B3F', 'GR', 'Statutory'),
    M(/ssnit/i,           'SSNIT',               '#1A5632', 'SS', 'Statutory'),
    M(/netflix/i,         'Netflix',             '#E50914', 'NF', 'Subscriptions'),
    M(/spotify/i,         'Spotify',             '#1DB954', 'SP', 'Subscriptions'),
    M(/mensah properties|rent/i,'Mensah Properties','#6D4C41','MP','Housing'),
    M(/ai-digital|ai digital|settlement|card settlement/i,'AI-Digital Bank','#14B8AC','AD','Income'),
  ];

  /** Resolve a raw transaction description to a known merchant, or synthesise one. */
  function merchant(name){
    const hit = MERCHANTS.find(m => m.match.test(name));
    if (hit) return hit;
    const slug = slugify(String(name));
    const words = String(name).replace(/[^A-Za-z ]/g,'').trim().split(/\s+/);
    const mark = (words[0]?.[0] || '?') + (words[1]?.[0] || words[0]?.[1] || '');
    /* deterministic grey-blue so unknown merchants never look broken */
    const hue = Math.floor(FID.seed(name) * 360);
    return {label:name, colour:`hsl(${hue} 34% 42%)`, mark:mark.toUpperCase(), cat:'Other', slug};
  }

  /* Where partner logo files live. Drop `bolt.svg`, `mtn.svg`, `ecg.svg` … into this
     folder and every statement row picks them up with no other change. The filename is
     the merchant slug, which `merchant()` returns. */
  let LOGO_DIR = 'logos/';
  const setLogoDir = dir => { LOGO_DIR = dir.endsWith('/') ? dir : dir + '/'; };

  /** Swap a missing logo for the generated mark. Called by the <img> onerror. */
  function logoFail(img){
    const span = document.createElement('span');
    span.className = 'brandtile fallback';
    span.setAttribute('style', img.dataset.fallback);
    span.textContent = img.dataset.mark;
    img.replaceWith(span);
  }

  /** The statement row mark: the partner's own logo when the file is there, a
      generated mark in their brand colour when it is not. */
  function brandTile(name, size = 44, radius = 14){
    const m = merchant(name);
    const fb = `width:${size}px;height:${size}px;border-radius:${radius}px;flex:none;` +
      `background:${m.colour};color:#fff;display:grid;place-items:center;font-weight:800;` +
      `font-size:${Math.round(size * 0.34)}px;letter-spacing:-.04em`;
    return `<img class="brandtile" src="${LOGO_DIR}${m.slug}.svg" alt="${m.label}" loading="lazy"
      data-mark="${m.mark}" data-fallback="${fb}" onerror="FID.logoFail(this)"
      style="width:${size}px;height:${size}px;border-radius:${radius}px;flex:none;object-fit:contain;
             background:#fff;padding:${Math.round(size*0.13)}px;border:1px solid var(--line)">`;
  }

  /* ------------------------------------------------------------- wallets */
  const MOMO = [
    {id:'mtn',    network:'MTN MoMo',    msisdn:'024 447 8812', balance:1240.50},
    {id:'telecel',network:'Telecel Cash',msisdn:'050 118 2204', balance:310.00},
  ];

  /* --------------------------------------------------------- the ledger */
  let txSeq = 9000;

  const dayLabel = ts => {
    const d = new Date(ts), now = new Date();
    const days = Math.floor((new Date(now.getFullYear(),now.getMonth(),now.getDate()) -
                             new Date(d.getFullYear(),d.getMonth(),d.getDate())) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB',{day:'numeric', month:'short'});
  };
  const timeLabel = ts => new Date(ts).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});

  /** Post a real movement. Balances change, the statement grows, and the row
      carries the record the decision layer already wrote. */
  function post(entity, {merchant:name, amount, account = 0, method = 'AI-Digital Bank account',
                         category, status = 'Completed', note = '', hash}){
    const acct = entity.accounts[account];
    const m = merchant_(name);
    const tx = {
      id: 'TX' + (++txSeq), ts: Date.now(), m: name, a: amount,
      cat: category || m.cat, method, status, note,
      ref: 'FID' + (txSeq * 7 % 999999).toString().padStart(6,'0'),
      hash: hash || ('0x' + Math.floor(FID.seed(name + amount + txSeq) * 0xfffffff).toString(16).padStart(7,'0')),
      balanceAfter: 0,
    };
    if (status === 'Completed'){
      acct.balance += amount;
      tx.balanceAfter = acct.balance;
    } else {
      tx.balanceAfter = acct.balance;
    }
    tx.d = dayLabel(tx.ts) + ' ' + timeLabel(tx.ts);
    entity.transactions.unshift(tx);
    return tx;
  }
  const merchant_ = merchant;

  /** Move money into a goal from an account or a mobile money wallet. */
  function fundGoal(entity, goal, amount, source){
    if (source.kind === 'account'){
      const acct = entity.accounts[source.index];
      if (acct.balance < amount)
        return {action:'INSUFFICIENT', confidence:1, adverse:true,
          explanation:`${acct.name} holds ${money0(acct.balance)}, which is less than ${money0(amount)}`};
      /* the debit itself is posted by the caller through post(), so the movement
         appears on the statement exactly once */
      goal.saved = Math.min(goal.target, goal.saved + amount);
      return {action:'FUNDED', confidence:1, adverse:false, from:acct.name,
        explanation:`moved from ${acct.name} instantly, no charge`};
    }
    const w = MOMO.find(x => x.id === source.id);
    if (w.balance < amount)
      return {action:'INSUFFICIENT', confidence:1, adverse:true,
        explanation:`${w.network} holds ${money0(w.balance)}, which is less than ${money0(amount)}`};
    w.balance -= amount;
    goal.saved = Math.min(goal.target, goal.saved + amount);
    return {action:'FUNDED', confidence:0.97, adverse:false, from:w.network,
      explanation:`collected from ${w.network} ${w.msisdn}; the network confirms within a minute`};
  }

  const money0 = n => 'GHS ' + Math.round(n).toLocaleString('en-GB');

  /* ------------------------------------ richer seeded statement history */
  const H = (days, hours, name, amount, method = 'Card', status = 'Completed') => {
    const ts = Date.now() - days*86400000 - hours*3600000;
    return {id:'TX'+(++txSeq), ts, m:name, a:amount, cat:merchant(name).cat, method, status,
            d: dayLabel(ts) + ' ' + timeLabel(ts),
            ref:'FID'+(txSeq*7%999999).toString().padStart(6,'0'),
            hash:'0x'+Math.floor(FID.seed(name+amount+ts)*0xfffffff).toString(16).padStart(7,'0'),
            balanceAfter:0};
  };

  FID.ENTITIES.personal.transactions = [
    H(0,2,'Bolt Ghana',-38.00), H(0,4,'Papaye Osu',-72.00,'Card'),
    H(1,3,'Melcom Osu',-214.50), H(1,9,'Salary — Ashesi University',6400.00,'Transfer in'),
    H(1,11,'MTN airtime',-20.00,'Mobile money'), H(2,5,'ECG prepaid',-150.00,'Bill payment'),
    H(2,8,'Bolt Ghana',-42.00), H(3,4,'Shoprite Accra Mall',-388.20),
    H(3,10,'Netflix',-71.00,'Card'), H(4,6,'Bolt Ghana',-51.00),
    H(5,2,'DStv Compact',-390.00,'Bill payment'), H(5,7,'Jumia order',-249.00,'Card'),
    H(6,3,'Rent — Mensah Properties',-1200.00,'Standing order'),
    H(7,5,'Ghana Water',-96.40,'Bill payment'), H(8,4,'KFC Airport City',-118.00),
    H(9,6,'Bolt Ghana',-44.00), H(10,3,'Palace Mall',-176.30),
    H(11,8,'Spotify',-29.00,'Card'), H(12,5,'Surfline data',-150.00,'Bill payment'),
  ];

  FID.ENTITIES.business.transactions = [
    H(0,3,'Card settlement — 214 covers',12840.00,'Settlement'),
    H(1,4,'Adom Poultry Farms',-12400.00,'Transfer'),
    H(2,2,'Payroll — 14 staff',-18900.00,'Bulk payment'),
    H(3,3,'Card settlement — 188 covers',10120.00,'Settlement'),
    H(4,5,'Ghana Water',-640.00,'Bill payment'),
    H(5,6,'Coastal Foods Ltd',8600.00,'Transfer in'),
    H(6,4,'GRA VAT return',-4180.00,'Bill payment'),
    H(7,2,'Ridge Hotel',6200.00,'Transfer in'),
    H(8,7,'SSNIT contributions',-2340.00,'Bill payment'),
  ];

  /* running balance backwards from today's position, so the statement adds up */
  for (const e of Object.values(FID.ENTITIES)){
    let bal = e.accounts[0].balance;
    for (const t of e.transactions){ t.balanceAfter = bal; bal -= t.a; }
  }

  return {MERCHANTS, merchant, brandTile, logoFail, setLogoDir, slugify,
          MOMO, post, fundGoal, dayLabel, timeLabel};
})());
