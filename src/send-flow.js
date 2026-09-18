/* ------------------------------------------------------------------ send money
   Nobody sends money to a number. They send it to a person, and they want to see
   the person's name before the money leaves. So every destination here resolves
   to a name first, and only then offers an amount.

   Three destinations, three lookups:
     Digital Bank — our own ledger, so the answer is immediate, and it says
                    whether the account is one of theirs or somebody else's
     Another bank — GIP name enquiry, whose session id has to travel back with
                    the transfer, so it is carried through untouched
     MoMo wallet  — the network's own holder lookup

   Confirming and saving are separate on purpose: a one-off payment should not
   quietly leave a beneficiary behind, and a payee someone keeps should be one
   they chose to keep. */

const SEND = {
  method: null,      // internal | bank | mobile_money
  who: null,         // self | other, for our own accounts
  resolved: null,    // what the enquiry answered
  bankList: null
};

function sendReset(){ SEND.method = null; SEND.who = null; SEND.resolved = null; }

function sendPickSheet(){
  sendReset();
  openSheet(`<h3 ${TITLE_CLASS}>Send money</h3>
    <p class="sub">Where is it going?</p>
    <div style="display:grid;gap:8px;margin-top:16px">
      <button class="btn ghost wide" data-act="send-internal">A Digital Bank account</button>
      <button class="btn ghost wide" data-act="send-bank">Another bank</button>
      <button class="btn ghost wide" data-act="send-momo">A mobile money wallet</button>
    </div>
    <button class="btn quiet wide" style="margin-top:12px" data-act="close">Cancel</button>`);
}

function sendWhoSheet(){
  openSheet(`<h3 ${TITLE_CLASS}>A Digital Bank account</h3>
    <p class="sub">Is this for you, or for somebody else?</p>
    <div style="display:grid;gap:8px;margin-top:16px">
      <button class="btn ghost wide" data-act="send-self">One of my own accounts</button>
      <button class="btn ghost wide" data-act="send-other">Someone else</button>
    </div>
    <button class="btn quiet wide" style="margin-top:12px" data-act="send-back">Back</button>`);
}

async function sendDetailSheet(message){
  const m = SEND.method;
  if (m === 'bank' && !SEND.bankList) SEND.bankList = await FID.banks();

  const field = m === 'mobile_money'
    ? `<label class="field"><span>Wallet number</span>
         <input id="sdTo" inputmode="tel" placeholder="024 123 4567" autofocus></label>`
    : m === 'bank'
      ? `<label class="field"><span>Bank</span><select id="sdBank">
           <option value="">Choose the bank</option>
           ${(SEND.bankList || []).map(b => `<option value="${b.code}">${b.name}</option>`).join('')}
         </select></label>
         <label class="field" style="margin-top:12px"><span>Account number</span>
           <input id="sdTo" inputmode="numeric" placeholder="1234567890"></label>`
      : `<label class="field"><span>Digital Bank account number</span>
           <input id="sdTo" inputmode="numeric" placeholder="5010000000" autofocus></label>`;

  openSheet(`<h3 ${TITLE_CLASS}>${m === 'mobile_money' ? 'Mobile money wallet'
      : m === 'bank' ? 'Another bank' : (SEND.who === 'self' ? 'Between my accounts' : 'Digital Bank account')}</h3>
    <p class="sub">We check the name before anything is sent.</p>
    ${message ? `<span class="badge r">${message}</span>` : ''}
    <div style="margin-top:16px">${field}</div>
    <button class="btn primary wide" style="margin-top:16px" data-act="send-lookup">Check the name</button>
    <button class="btn quiet wide" style="margin-top:8px" data-act="send-back">Back</button>`);
}

async function sendLookup(){
  const to = ($('sdTo')?.value || '').trim();
  const bankCode = $('sdBank')?.value || '';
  if (!to) return sendDetailSheet('Enter the account number');
  if (SEND.method === 'bank' && !bankCode) return sendDetailSheet('Choose the bank first');
  if (SEND.method === 'mobile_money' && !FID.normaliseMsisdn(to))
    return sendDetailSheet('Enter a Ghana mobile number, for example 024 123 4567');

  openSheet(`<h3 ${TITLE_CLASS}>Checking…</h3><p class="sub">Looking up the account holder.</p>`);
  try {
    const body = SEND.method === 'mobile_money'
      ? {method:'mobile_money', msisdn: to}
      : {method: SEND.method, accountNumber: to, bankCode};
    const out = await FID.nameEnquiry(body);

    // Sending to your own account is a different intention from sending to
    // someone else; if the answer disagrees with what they picked, say so.
    if (SEND.method === 'internal' && SEND.who === 'self' && !out.self)
      return sendDetailSheet('That account is not one of yours');
    if (SEND.method === 'internal' && SEND.who === 'other' && out.self)
      return sendDetailSheet('That is your own account — choose "One of my own accounts"');

    SEND.resolved = {...out, accountNumber: out.accountNumber || to, bankCode};
    sendConfirmSheet();
  } catch (err) {
    sendDetailSheet(err.message);
  }
}

function sendConfirmSheet(message, kind){
  const r = SEND.resolved;
  openSheet(`<h3 ${TITLE_CLASS}>${r.name}</h3>
    <p class="sub">${r.bank || ''}${r.branch ? ' · ' + r.branch : ''}<br>
      <span class="ref">${r.accountNumber}</span></p>
    ${message ? `<span class="badge ${kind || 'r'}">${message}</span>` : ''}
    <label class="field" style="margin-top:16px"><span>Amount (GH₵)</span>
      <input id="sdAmt" inputmode="decimal" placeholder="0.00" autofocus></label>
    <label class="field" style="margin-top:12px"><span>What is this for?</span>
      <input id="sdNote" maxlength="100" placeholder="Rent"></label>
    <div style="display:grid;gap:8px;margin-top:18px">
      <button class="btn primary wide" data-act="send-save-go">Save payee and send</button>
      <button class="btn ghost wide" data-act="send-go">Send without saving</button>
    </div>
    <button class="btn quiet wide" style="margin-top:8px" data-act="send-back">Back</button>`);
}

async function sendGo(save){
  const r = SEND.resolved;
  const amount = Number(($('sdAmt')?.value || '').replace(/[^0-9.]/g, ''));
  const note = ($('sdNote')?.value || '').trim() || `Transfer to ${r.name}`;
  if (!amount || amount < 1) return sendConfirmSheet('Enter GH₵1.00 or more');

  if (save){
    try {
      await FID.savePayee({
        name: r.name, method: SEND.method, accountRef: r.accountNumber,
        bank: r.bank, bankCode: r.bankCode || undefined
      });
    } catch (err) {
      // Failing to save is not a reason to lose the payment they came here to make.
      return sendConfirmSheet(err.message + ' — you can still send without saving.', 'o');
    }
  }

  /* The existing payment gate runs from here: PIN, then a one-time code, then
     the screening the rest of the product already applies. */
  requireAuthForPayment(
    {account: S.acct, merchant: r.name, amount: -amount, category: 'Transfer',
     method: SEND.method === 'internal' ? 'Digital Bank' : SEND.method === 'bank' ? 'Bank transfer' : 'Mobile money'},
    () => { syncAccountsFromServer(); }
  );
}

/* ---- wallet to bank: money that never touches the card ------------------------------
   The other direction from a top up. The wallet is debited first and the bank
   leg follows only once that has actually settled. */
async function walletToBankSheet(message){
  if (!SEND.bankList) SEND.bankList = await FID.banks();
  openSheet(`<h3 ${TITLE_CLASS}>Wallet to bank</h3>
    <p class="sub">Move money from your mobile wallet straight to a bank account.
      You approve the wallet debit on your phone; the bank leg follows once it clears.</p>
    ${message ? `<span class="badge r">${message}</span>` : ''}
    <label class="field" style="margin-top:16px"><span>Your wallet number</span>
      <input id="w2bFrom" inputmode="tel" placeholder="024 123 4567"></label>
    <label class="field" style="margin-top:12px"><span>Bank</span><select id="w2bBank">
      <option value="">Choose the bank</option>
      ${(SEND.bankList || []).map(b => `<option value="${b.code}">${b.name}</option>`).join('')}
    </select></label>
    <label class="field" style="margin-top:12px"><span>Account number</span>
      <input id="w2bTo" inputmode="numeric"></label>
    <label class="field" style="margin-top:12px"><span>Amount (GH₵)</span>
      <input id="w2bAmt" inputmode="decimal" placeholder="0.00"></label>
    <button class="btn primary wide" style="margin-top:16px" data-act="w2b-go">Check and send</button>
    <button class="btn quiet wide" style="margin-top:8px" data-act="close">Cancel</button>`);
}

async function walletToBankGo(){
  const from = ($('w2bFrom')?.value || '').trim();
  const to = ($('w2bTo')?.value || '').trim();
  const bankCode = $('w2bBank')?.value || '';
  const amount = Number(($('w2bAmt')?.value || '').replace(/[^0-9.]/g, ''));
  if (!FID.normaliseMsisdn(from)) return walletToBankSheet('Enter a Ghana mobile number, for example 024 123 4567');
  if (!bankCode || !to) return walletToBankSheet('Choose the bank and enter the account number');
  if (!amount || amount < 1) return walletToBankSheet('Enter GH₵1.00 or more');

  try {
    const enquiry = await FID.nameEnquiry({method:'bank', accountNumber: to, bankCode});
    const accountId = await FID.primaryAccountId();
    const out = await FID.walletToBank({
      accountId, amountMinor: Math.round(amount * 100),
      msisdn: FID.normaliseMsisdn(from),
      destination: {accountNumber: to, bankCode, name: enquiry.name, enquiry: enquiry.enquiry},
      narration: `To ${enquiry.name}`
    });
    openSheet(`<h3 ${TITLE_CLASS}>Approve it on your phone</h3>
      <p class="sub">${out.awaiting}</p>
      <p class="sub">Going to <b>${enquiry.name}</b> at ${enquiry.bank}.</p>
      <button class="btn primary wide" style="margin-top:16px" data-act="close">Done</button>`);
    setTimeout(() => syncAccountsFromServer(), 6000);
  } catch (err) {
    walletToBankSheet(err.message);
  }
}
