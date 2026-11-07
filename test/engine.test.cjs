const FX=require('../js/engine.js'); const assert=require('assert');
const prof={start:'2026-11-09',dob:'1995-05-01',height:180,weight:92,target:82,sex:'m',baseline:{done:true,run5k:1620,pushups:25,plank:80,wallsit:70}};
// week layout
const w=FX.weekPlan('2026-11-11',prof); console.log(w.list.map(s=>s.date+' '+s.title+' '+s.est+'m').join('\n'));
assert.equal(w.list.length,7);
// moves slide
const p2={...prof,moves:['2026-11-10']}; const w2=FX.weekPlan('2026-11-11',p2);
assert.equal(w2.list[1].type,'moved'); assert.equal(w2.list[2].type,'run_int'); assert.ok(w2.list[2].fromMove); assert.equal(w2.dropped[0].type,'mob');
assert.equal(FX.canMove('2026-11-15',prof).ok,false);
// phases
for(const d of ['2026-11-20','2027-01-20','2027-03-01','2027-03-11','2027-03-13','2027-03-15','2027-03-17','2027-04-20','2027-07-07','2027-08-10','2027-10-10']) console.log(d,FX.phase(d,prof).id, FX.sessionFor(d,prof).title, FX.sessionFor(d,prof).heat?'HEAT':'');
// readiness
assert.equal(FX.readiness({readiness:50},{}).light,'red');
assert.equal(FX.readiness({readiness:65,sleep_score:80},{}).light,'amber');
assert.equal(FX.readiness({readiness:85,sleep_score:85,temp_dev:0.6},{}).light,'red');
assert.equal(FX.readiness(null,{sick:true}).light,'red');
const s=FX.sessionFor('2026-11-10',prof); const a=FX.adapt(s,FX.readiness({readiness:60},{})); console.log('amber:',a.title); const r=FX.adapt(s,{light:'red',why:['x']}); assert.equal(r.type,'recover');
// verify
assert.ok(FX.verify(s,[{sport:'Run',dur_s:2400}])); assert.ok(!FX.verify(s,[{sport:'WeightTraining',dur_s:2400}]));
console.log(FX.targets(prof,92));
// score
const days={'2026-11-09':{s:{status:'done'},ci:{feel:4},w:92,food:[{kcal:800,p:60},{kcal:900,p:70},{kcal:500,p:40}],water:3500,drills:[1]},'2026-11-10':{}};
const sc=FX.weekScore('2026-11-10',{profile:prof,today:'2026-11-11',day:d=>days[d],acts:d=>d==='2026-11-10'?[{sport:'Run',dur_s:2600}]:[],oura:()=>({sleep_score:80}),bt:()=>0});
console.log(sc.total,JSON.stringify(sc.parts,null,0)); console.log(sc.fixes);
console.log('OK');
