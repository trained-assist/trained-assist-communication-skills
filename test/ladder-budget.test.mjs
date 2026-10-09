import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ladderChat,LadderError} from '../src/ladder.mjs';
import {extractConversationState} from '../src/state-handler.mjs';
import {evaluateNextGoal} from '../src/goal-handler.mjs';
import {generateNextMessage} from '../src/handler.mjs';
import {resolveUserIntent} from '../src/intent-handler.mjs';
const ENV={LLM_LADDER_URL:'http://fixture-ladder',LLM_LADDER_TOKEN:'fixture'};
function stub({contents=[],elapsed=[0],failure=false}={}){
 const originalFetch=globalThis.fetch,originalNow=Date.now,originalTimeout=AbortSignal.timeout;let clock=1000;const calls=[],timeouts=[],headers=[];
 Date.now=()=>clock;AbortSignal.timeout=n=>{timeouts.push(n);return new AbortController().signal;};
 globalThis.fetch=async(_url,init)=>{const index=calls.length;calls.push(JSON.parse(init.body));headers.push(init.headers);clock+=elapsed[index]??0;if(failure)throw new Error('fixture provider unavailable');return new Response(JSON.stringify({model:'fixture-model',choices:[{message:{content:contents[index]??contents.at(-1)}}]}),{status:200});};
 return{calls,timeouts,headers,restore(){globalThis.fetch=originalFetch;Date.now=originalNow;AbortSignal.timeout=originalTimeout;}};
}
test('shared ladder keeps a 60s rung inside the fixed 120s total method budget',async()=>{
 const f=stub({contents:['done']});try{await ladderChat({baseUrl:ENV.LLM_LADDER_URL,token:ENV.LLM_LADDER_TOKEN,model:'service:classify',messages:[{role:'user',content:'fixture'}]});assert.equal(f.calls[0].ladder_timeout_ms,60000);assert.equal(f.calls[0].ladder_total_timeout_ms,120000);assert.deepEqual(f.timeouts,[125000]);}finally{f.restore();}
});
test('reasoning effort is an explicit allowlisted provider option',async()=>{
 const f=stub({contents:['done']});try{await ladderChat({baseUrl:ENV.LLM_LADDER_URL,token:ENV.LLM_LADDER_TOKEN,model:'service:classify',messages:[{role:'user',content:'fixture'}],reasoningEffort:'low'});assert.equal(f.calls[0].reasoning_effort,'low');await assert.rejects(ladderChat({baseUrl:ENV.LLM_LADDER_URL,messages:[{role:'user',content:'fixture'}],reasoningEffort:'unbounded'}),LadderError);}finally{f.restore();}
});
const methods=[
 {name:'intent',run:()=>resolveUserIntent({request_id:'intent-budget',trace_id:'intent-trace',input_bundle:{id:'synthetic',events:[{id:'event',type:'text',author:'user',text:'Проверить доступность помощника'}]},recipient:{role:'Помощник'},decision_options:[{id:'system_health',description:'Проверить доступность системы после выбора маршрута'}]},ENV),invalid:'not-json',valid:JSON.stringify({user_goal:'Узнать, доступен ли помощник сейчас',decision:'system_health'})},
 {name:'state',run:()=>extractConversationState({request_id:'state-budget',trace_id:'state-trace',conversation_revision:'rev',conversation_history:{format:'messages',messages:[]},state_schema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false}},ENV),invalid:'not-json',valid:JSON.stringify({state:{summary:'fixture'}})},
 {name:'goal',run:()=>evaluateNextGoal({request_id:'goal-budget',trace_id:'goal-trace',conversation_revision:'rev',conversation_state:{},conversation_objective:'Следовать синтетическому сценарию'},ENV),invalid:'not-json',valid:JSON.stringify({status:'wait'})},
 {name:'writer',run:()=>generateNextMessage({request_id:'writer-budget',trace_id:'writer-trace',context_revision:'rev',goal:{instruction:'Запросить портфолио'},language:'ru',communication_style:{instructions:'Кратко'},conversation_history:{format:'messages',messages:[]},constraints:{forbidden_claims:['гарантия трудоустройства']}},ENV),invalid:'Гарантия трудоустройства.',valid:'Пришлите ссылку на портфолио.'},
];
for(const method of methods){
 test(`${method.name}: a valid 38s answer fits one rung without a discarded 20s attempt`,async()=>{
  const f=stub({contents:[method.valid],elapsed:[38000]});try{const r=await method.run();assert.equal(r.isError,false,JSON.stringify(r.data));assert.equal(f.calls.length,1);assert.equal(f.calls[0].ladder_timeout_ms,60000);assert.equal(f.calls[0].ladder_total_timeout_ms,120000);assert.equal(f.headers[0]['x-ladder-trace'],`${method.name}-trace`);if(method.name==='intent')assert.equal(f.calls[0].reasoning_effort,'low');}finally{f.restore();}
 });
 test(`${method.name}: schema/guard repair receives only remaining method budget`,async()=>{
  const f=stub({contents:[method.invalid,method.valid],elapsed:[30000,1000]});try{const r=await method.run();assert.equal(r.isError,false,JSON.stringify(r.data));assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(x=>x.ladder_total_timeout_ms),[120000,90000]);assert.deepEqual(f.calls.map(x=>x.ladder_timeout_ms),[60000,60000]);assert.deepEqual(f.timeouts,[125000,95000]);}finally{f.restore();}
 });
 test(`${method.name}: exhausted total budget is typed and does not start another attempt`,async()=>{
  const f=stub({contents:[method.invalid,method.valid],elapsed:[120001]});try{const r=await method.run();assert.equal(r.isError,true);assert.equal(r.data.error.code,'LLM_UNAVAILABLE');assert.equal(r.data.error.budget_exhausted,true);assert.equal(r.data.error.budget_ms,120000);assert.equal(f.calls.length,1);}finally{f.restore();}
 });
}
test('provider unavailable stays bounded to one shared ladder call; no hidden client retry',async()=>{
 const f=stub({failure:true,elapsed:[20000]});try{const r=await methods[0].run();assert.equal(r.data.error.code,'LLM_UNAVAILABLE');assert.equal(f.calls.length,1);await assert.rejects(ladderChat({baseUrl:ENV.LLM_LADDER_URL,messages:[{role:'user',content:'x'}],totalTimeoutMs:0}),LadderError);assert.equal(f.calls.length,1);}finally{f.restore();}
});

test('explicit shorter rung timeout stays bounded by the remaining total deadline',async()=>{
 const f=stub({contents:['done']});try{await ladderChat({baseUrl:ENV.LLM_LADDER_URL,messages:[{role:'user',content:'fixture'}],timeoutMs:40000,totalTimeoutMs:12000});assert.equal(f.calls[0].ladder_timeout_ms,12000);assert.equal(f.calls[0].ladder_total_timeout_ms,12000);assert.deepEqual(f.timeouts,[17000]);}finally{f.restore();}
});

test('caller trace IDs are safe ASCII HTTP headers while UUID correlation stays unchanged',async()=>{
 const f=stub({contents:['done']});try{for(const traceId of ['трасса\n123','6239c236-8068-4bd6-98e3-69ab4ab3e162']){await ladderChat({baseUrl:ENV.LLM_LADDER_URL,messages:[{role:'user',content:'fixture'}],traceId});const value=f.headers.at(-1)['x-ladder-trace'];assert.equal(value,encodeURIComponent(traceId));assert.equal(new Headers(f.headers.at(-1)).get('x-ladder-trace'),value);}}finally{f.restore();}
});
