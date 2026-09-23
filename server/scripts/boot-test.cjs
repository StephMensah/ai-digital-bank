const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');

const file = process.argv[2];
const signedIn = process.argv[3] === 'signedin';
const html = fs.readFileSync('/home/claude/repo/' + file, 'utf8');
const errors = [];

const store = signedIn
  ? { 'adb.session': JSON.stringify({ accessToken: 'x', subject: { full_name: 'Test Person' } }) }
  : {};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://pokzbank.org/' + file,
  beforeParse(w) {
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(w, 'localStorage', {
      value: {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; }
      }
    });
    // every call fails the way an expired session does
    w.fetch = () => Promise.resolve({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: { code: 'unauthorized', message: 'Sign in to continue' } })
    });
    w.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
    w.onerror = (m) => errors.push(String(m));
  }
});

setTimeout(() => {
  const d = dom.window.document;
  const gate = d.querySelector('.gate');
  // textContent includes inline <script> source, which carries the bundled
  // sample data as string literals — strip scripts to see what a person sees.
  d.querySelectorAll('script').forEach((el) => el.remove());
  const body = d.body.textContent || '';
  console.log(`${file} (${signedIn ? 'signed in' : 'signed out'})`);
  console.log('  script errors :', errors.length ? errors.slice(0, 2).join(' | ') : 'none');
  console.log('  gate shown    :', Boolean(gate));
  console.log('  gate says     :', (gate?.textContent || '').trim().slice(0, 40).replace(/\s+/g, ' '));
  console.log('  Ama on screen :', /Ama Boateng|Ama's Kitchen/.test(body));
  console.log('  rendered app  :', Boolean(d.querySelector('.hero, #view')));
  dom.window.close();
  process.exit(0);
}, 1200);
