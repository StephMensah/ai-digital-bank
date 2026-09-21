const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
const html = fs.readFileSync('/home/claude/repo/public/pitch.html','utf8');
const errors = [];
const dom = new JSDOM(html,{runScripts:'dangerously',url:'https://pokzbank.org/pitch#3',
  beforeParse(w){ w.matchMedia=()=>({matches:false}); w.addEventListener('error',e=>errors.push(e.message)); }});
const w = dom.window, d = w.document;
setTimeout(()=>{
  const slides = d.querySelectorAll('.slide');
  const on = () => [...slides].findIndex(s => s.classList.contains('on'));
  console.log('slides            :', slides.length);
  console.log('opens on #3       :', on() === 2);
  w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight'}));
  console.log('arrow advances    :', on() === 3, '| hash', w.location.hash);
  w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'End'}));
  console.log('End reaches last  :', on() === slides.length - 1);
  w.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight'}));
  console.log('stops at the end  :', on() === slides.length - 1);
  console.log('no speaker notes  :', !d.querySelector('aside'));
  console.log('no x-shape left   :', !d.querySelector('x-shape'));
  console.log('noindex           :', /noindex/.test(d.querySelector('meta[name=robots]').content));
  console.log('errors            :', errors.length ? errors[0] : 'none');
  process.exit(0);
}, 300);
