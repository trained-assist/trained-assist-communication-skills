import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ladderChat,LadderError} from '../src/ladder.mjs';
import {extractConversationState} from '../src/state-handler.mjs';
import {evaluateNextGoal} from '../src/goal-handler.mjs';
import {generateNextMessage} from '../src/handler.mjs';
const ENV={LLM_LADDER_URL:'http://fixture-ladder',LLM_LADDER_TOKEN:'fixture'};
function stub({contents=[],elapsed=[0],failure=false}={}){
 const originalFetch=globalThis.fetch,originalNow=Date.now,originalTimeout=AbortSignal.timeout;let clock=1000;const calls=[],timeouts=[];
 Date.now=()=>clock;AbortSignal.timeout=n=>{timeouts.push(n);return new AbortController().signal;};
 globalThis.fetch=async(_url,init)=>{const index=calls.length;calls.push(JSON.parse(init.body));clock+=elapsed[index]??0;if(failure)throw new Error('fixture provider unavailable');return new Response(JSON.stringify({model:'fixture-model',choices:[{message:{content:contents[index]??contents.at(-1)}}]}),{status:200});};
 return{calls,timeouts,restore(){globalThis.fetch=originalFetch;Date.now=originalNow;AbortSignal.timeout=originalTimeout;}};
}
test('shared ladder receives total60s separately from per-rung20s, transport allows completion of fallback rung',async()=>{
 const f=stub({contents:['done']});try{await ladderChat({baseUrl:ENV.LLM_LADDER_URL,token:ENV.LLM_LADDER_TOKEN,model:'service:classify',messages:[{role:'user',content:'fixture'}]});assert.equal(f.calls[0].ladder_timeout_ms,20000);assert.equal(f.calls[0].ladder_total_timeout_ms,60000);assert.deepEqual(f.timeouts,[65000]);}finally{f.restore();}
});
const methods=[
 {name:'state',run:()=>extractConversationState({request_id:'state-budget',conversation_revision:'rev',conversation_history:{format:'messages',messages:[]},state_schema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}},ENV),invalid:'not-json',valid:JSON.stringify({state:{summary:'fixture'}})},
 {name:'goal',run:()=>evaluateNextGoal({request_id:'goal-budget',conversation_revision:'rev',conversation_state:{},conversation_objective:'Следовать синтетическому сценарию'},ENV),invalid:'not-json',valid:JSON.stringify({status:'wait'})},
 {name:'writer',run:()=>generateNextMessage({request_id:'writer-budget',context_revision:'rev',goal:{instruction:'Запросить портфолио'},language:'ru',communication_style:{instructions:'Кратко'},conversation_history:{format:'messages',messages:[]},constraints:{forbidden_claims:['гарантия трудоустройства']}},ENV),invalid:'Гарантия трудоустройства.',valid:'Пришлите ссылку на портфолио.'},
];
for(const method of methods){
 test(`${method.name}: schema/guard repair receives only remaining method budget`,async()=>{
  const f=stub({contents:[method.invalid,method.valid],elapsed:[30000,1000]});try{const r=await method.run();assert.equal(r.isError,false,JSON.stringify(r.data));assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(x=>x.ladder_total_timeout_ms),[60000,30000]);assert.deepEqual(f.calls.map(x=>x.ladder_timeout_ms),[20000,20000]);assert.deepEqual(f.timeouts,[65000,35000]);}finally{f.restore();}
 });
 test(`${method.name}: exhausted total budget is typed and does not start another attempt`,async()=>{
  const f=stub({contents:[method.invalid,method.valid],elapsed:[60001]});try{const r=await method.run();assert.equal(r.isError,true);assert.equal(r.data.error.code,'LLM_UNAVAILABLE');assert.equal(r.data.error.budget_exhausted,true);assert.equal(r.data.error.budget_ms,60000);assert.equal(f.calls.length,1);}finally{f.restore();}
 });
}
test('provider unavailable stays bounded to one shared ladder call; no hidden client retry',async()=>{
 const f=stub({failure:true,elapsed:[20000]});try{const r=await methods[0].run();assert.equal(r.data.error.code,'LLM_UNAVAILABLE');assert.equal(f.calls.length,1);await assert.rejects(ladderChat({baseUrl:ENV.LLM_LADDER_URL,messages:[{role:'user',content:'x'}],totalTimeoutMs:0}),LadderError);assert.equal(f.calls.length,1);}finally{f.restore();}
});
