const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
let pass=0, fail=0;
const ok=(m)=>{pass++;console.log('  ✓',m)}, bad=(m,g)=>{fail++;console.log('  ✗',m,'—',g)};

function boot(file, profile){
  const html = fs.readFileSync('/home/claude/repo/'+file,'utf8');
  const errors=[]; const ss={'adb.session':JSON.stringify({accessToken:'t',subject:{full_name:'Yaw Esson'}})};
  const dom = new JSDOM(html,{runScripts:'dangerously',url:'https://pokzbank.org/'+file,beforeParse(w){
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    const store=(o)=>({getItem:k=>o[k]??null,setItem:(k,v)=>{o[k]=v},removeItem:k=>{delete o[k]}});
    Object.defineProperty(w,'sessionStorage',{value:store(ss)});
    Object.defineProperty(w,'localStorage',{value:store({})});
    w.fetch=(u)=>{const s=b=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(b)});
      u=String(u);
      if(u.includes('/api/health')) return s({status:'ok'});
      if(u.includes('/api/accounts/')) return s(profile);
      if(u.includes('/api/v1/accounts')) return s({accounts:[]});
      if(u.includes('/invest/')) return s({assets:[],holdings:[],loans:[],valueMinor:0,gainMinor:0,borrowedMinor:0,orders:[]});
      if(u.includes('/cards/linked')) return s({cards:[]});
      return s({});};
    w.addEventListener('error',e=>errors.push(e.message||String(e.error)));
    w.onerror=m=>errors.push(String(m));
  }});
  return {w:dom.window,d:dom.window.document,errors,ss};
}
const empty = (extra) => ({entity:'personal',mustChangePin:false,accounts:[],transactions:[],goals:[],beneficiaries:[],...extra});

(async()=>{
  for (const file of ['app.html','web.html']){
    console.log('\n── '+file);

    // the screenshot: signed in, verification awaiting a reviewer, no account yet
    let {w,d,errors} = boot(file, empty({kycStatus:'in_review', onboardingComplete:true}));
    await new Promise(r=>setTimeout(r,700));
    const screens = file==='app.html' ? ['home','you','cards','save','invest'] : ['overview','statements','cards','save','invest'];
    for (const s of screens){
      try { w.eval(`S.tab='${s}'; S.view='${s}'; render();`); ok(`${s} renders with no account`); }
      catch(e){ bad(`${s} renders with no account`, e.message); }
    }
    errors.length ? bad('no uncaught errors', errors[0]) : ok('no uncaught errors');
    !d.querySelector('.gate') ? ok('an account under review stays signed in') : bad('under review','was thrown out');
    w.close();

    // an abandoned signup: no PIN, never verified
    ({w,d,errors} = boot(file, empty({kycStatus:'pending', mustChangePin:true, onboardingComplete:false})));
    await new Promise(r=>setTimeout(r,700));
    const gate = d.querySelector('.gate');
    gate ? ok('unfinished signup is sent back to the start') : bad('restart','no gate');
    /started it again/.test(gate?.textContent||'') ? ok('and told why') : bad('restart message', (gate?.textContent||'').slice(0,60));
    /Open an account/.test(gate?.textContent||'') ? ok('on the open-an-account form') : bad('form','not the open form');
    w.close();
  }
  console.log(`\npassed ${pass}, failed ${fail}`);
  process.exit(fail?1:0);
})();
