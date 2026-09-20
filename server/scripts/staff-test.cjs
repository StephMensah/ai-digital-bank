const { JSDOM } = require('/home/claude/node_modules/jsdom');
const fs = require('fs');
let pass=0, fail=0;
const ok=(m)=>{pass++;console.log('  ✓',m)};
const bad=(m,g)=>{fail++;console.log('  ✗',m,'—',g)};

function boot(file, signedIn){
  const html = fs.readFileSync('/home/claude/repo/'+file,'utf8');
  const errors=[]; const calls=[];
  const store = signedIn ? {'adb.staff': JSON.stringify({accessToken:'t', subject:{full_name:'Ops'}})} : {};
  const dom = new JSDOM(html,{runScripts:'dangerously',url:'https://pokzbank.org/'+file,
    beforeParse(w){
      w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
      Object.defineProperty(w,'localStorage',{value:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v},removeItem:k=>{delete store[k]}}});
      w.fetch=(u,o={})=>{calls.push((o.method||'GET')+' '+String(u).replace('https://pokzbank.org',''));
        const send=b=>Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(b)});
        if(String(u).includes('/reviewer/cases')) return send({cases:[{id:'c1',case_number:12,case_type:'transaction',customer_name:'Ama Boateng',amount_minor:450000,currency:'GHS',risk_score:72,summary:'Large amount to a new payee',sla_due_at:new Date(Date.now()+900000).toISOString(),status:'open'}]});
        if(String(u).includes('/reviewer/metrics')) return send({metrics:{queue_depth:1,sla_breached:0,decided_today:4,avg_handle_seconds:220}});
        if(String(u).includes('/tower/overview')) return send({volumes:{tx_last_hour:12,value_last_day_minor:450000,stuck:0,held:1},queues:{outbox_queued:2,outbox_dead:0},rails:[],incidents:[]});
        if(String(u).includes('/tower/health')) return send({components:[{component:'mambu',status:'mock',detail:'sandbox'}]});
        if(String(u).includes('/tower/reconciliation')) return send({clean:true,breaks:[]});
        if(String(u).includes('/auth/staff/login')) return send({staff:{full_name:'Ops'},tokens:{accessToken:'t'}});
        return send({});};
      w.addEventListener('error',e=>errors.push(e.message||String(e.error)));
      w.onerror=m=>errors.push(String(m));
    }});
  return {dom,w:dom.window,d:dom.window.document,errors,calls};
}
(async()=>{
  for (const file of ['reviewer-console.html','control-tower.html']){
    console.log('\n── '+file);
    let {d,errors,w} = boot(file,false);
    await new Promise(r=>setTimeout(r,500));
    d.querySelector('.sgate') ? ok('signed out shows the staff gate') : bad('staff gate','absent');
    errors.length? bad('no errors signed out',errors[0]) : ok('no errors signed out');
    w.close();

    ({d,errors,calls:undefined,w} = boot(file,true));
    await new Promise(r=>setTimeout(r,600));
    !d.querySelector('.sgate') ? ok('signed in skips the gate') : bad('signed in','gate still up');
    const body=d.body.textContent||'';
    if (file.includes('reviewer')) /Ama Boateng/.test(body)? ok('live case listed'):bad('live case','not rendered');
    else /payments in the last hour/.test(body)? ok('live figures rendered'):bad('live figures','missing');
    errors.length? bad('no errors signed in',errors[0]) : ok('no errors signed in');
    w.close();
  }
  console.log(`\npassed ${pass}, failed ${fail}`);
  process.exit(fail?1:0);
})();
