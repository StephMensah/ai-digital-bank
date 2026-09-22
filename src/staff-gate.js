/* ------------------------------------------------------------------ staff gate
   These two consoles were open: no login, and calls straight to the API. The
   server refused them, so the pages showed nothing and looked broken rather
   than locked. A queue of customers' held payments and a view of every rail
   should be behind a login even when the API is already refusing. */

const STAFF_STORE = 'adb.staff';
/* Staff sessions are tab-scoped too: a console holding customers' held
   payments should not stay signed in after the browser closes. */
const staffBox = (() => { try { return window.sessionStorage; } catch { return null; } })();
try { localStorage.removeItem(STAFF_STORE); } catch {}
let staff = (() => { try { return JSON.parse((staffBox && staffBox.getItem(STAFF_STORE)) || 'null'); } catch { return null; } })();
const staffedIn = () => Boolean(staff && staff.accessToken);
const staffHeaders = () => (staffedIn() ? { Authorization: 'Bearer ' + staff.accessToken } : {});

function keepStaff(next) {
  staff = next;
  try { next ? staffBox.setItem(STAFF_STORE, JSON.stringify(next)) : staffBox.removeItem(STAFF_STORE); }
  catch { /* private window: the session lasts the tab */ }
}

function staffGate(message) {
  let el = document.querySelector('.sgate');
  if (!el) { el = document.createElement('div'); el.className = 'sgate'; document.body.appendChild(el); }
  el.innerHTML = `<form class="spanel" id="sgForm">
      <div class="sbrand">Digital Bank</div>
      <h2>${CONSOLE_NAME}</h2>
      <p>Staff access. Sign in with your work account.</p>
      ${message ? `<div class="serr">${message}</div>` : ''}
      <label>Work email<input id="sgEmail" type="email" autocomplete="username" autofocus></label>
      <label>Password<input id="sgPass" type="password" autocomplete="current-password"></label>
      <button class="sbtn" type="submit">Sign in</button>
    </form>`;
  el.querySelector('#sgForm').addEventListener('submit', (ev) => { ev.preventDefault(); staffSignIn(); });
  document.documentElement.classList.add('gated');
}

function closeStaffGate() {
  document.querySelector('.sgate')?.remove();
  document.documentElement.classList.remove('gated');
}

async function staffSignIn() {
  const email = (document.getElementById('sgEmail')?.value || '').trim();
  const password = document.getElementById('sgPass')?.value || '';
  if (!email || !password) return staffGate('Enter your email and password.');
  try {
    const res = await fetch('/api/v1/auth/staff/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return staffGate(res.status === 401
        ? 'That email and password do not match.'
        : (json.error?.message || 'Could not sign you in just now.'));
    }
    const tokens = json.tokens || json;
    keepStaff({ accessToken: tokens.accessToken, subject: json.staff || json.user });
    closeStaffGate();
    boot();
  } catch {
    staffGate('Could not reach the service just now.');
  }
}

function staffSignOut() {
  keepStaff(null);
  staffGate();
}

/** A 401 mid-session means the token expired; ask again rather than blank out. */
function onStaffUnauthorised() {
  keepStaff(null);
  staffGate('Your session expired. Sign in again.');
}
