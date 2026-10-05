import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateNextGoal, normalizeGoalInput } from '../src/goal-handler.mjs';
import { validateGoalDecision, buildGoalDecisionSchema } from '../src/goal-schema.mjs';
import { renderStatePrompt } from '../src/state-prompt.mjs';
import { normalizeStateInput, stateInputMetrics, extractConversationState } from '../src/state-handler.mjs';
import worker from '../src/index.mjs';
const bindings = [{ stage_id: 'stage-xyz' }];
const goal = { instruction: 'Передать сохранённый материал следующего этапа' };
const input = { request_id: 'binding-case', conversation_revision: 'rev-full', conversation_objective: 'Пройти редактируемый сценарий', conversation_state: {}, material_bindings: bindings };
const ENV = { COMMUNICATION_TOKEN: 'fixture', LLM_LADDER_URL: 'http://ladder.test', LLM_LADDER_TOKEN: 'fixture' };
async function mockLadder(answer, callback) {
 const original = globalThis.fetch; let calls = 0;
 globalThis.fetch = async (_url, init) => { calls++; callback?.(JSON.parse(init.body)); return new Response(JSON.stringify({model:'fixture',choices:[{message:{content:JSON.stringify(answer)}}]})); };
 try { return await evaluateNextGoal(input, ENV); } finally { globalThis.fetch = original; }
}
test('verbatim execution is an explicit reference, free goal is preserved', async () => {
 const r = await mockLadder({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'stage-xyz'}}, body => {
  assert.deepEqual(body.response_format.json_schema.schema.properties.execution.anyOf.find(variant => variant.properties?.type?.enum?.includes('send_material')).properties.stage_id.enum,['stage-xyz']);
  assert.match(body.messages.at(-1).content,/stage-xyz/);
 });
 assert.equal(r.isError,false); assert.equal(r.data.goal.instruction,goal.instruction);
 assert.deepEqual(r.data.execution,{type:'send_material',stage_id:'stage-xyz'});
 assert.equal(r.data.conversation_revision,'rev-full');
});
test('unknown material id is rejected after bounded attempts', async () => {
 const r=await mockLadder({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'forged'}});
 assert.equal(r.data.error.code,'GOAL_REJECTED'); assert.equal(r.data.error.attempts,2);
});
test('terminal status cannot deliver material', () => {
 assert.equal(validateGoalDecision({status:'wait',execution:{type:'send_material',stage_id:'stage-xyz'}},bindings).ok,false);
});
test('normal open message may interrupt any stage without sending its material', () => {
 const r=validateGoalDecision({status:'goal_ready',goal:{instruction:'Ответить на вопрос кандидата об оплате'},execution:{type:'write_message'}},bindings);
 assert.equal(r.ok,true);assert.deepEqual(r.value.execution,{type:'write_message'});
});
test('old consumer response stays compatible and cannot fabricate execution', () => {
 const r=validateGoalDecision({status:'goal_ready',goal}); assert.equal(r.ok,true);assert.equal(Object.hasOwn(r.value,'execution'),false);
 assert.equal(validateGoalDecision({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'stage-xyz'}}).ok,false);
 assert.equal(Object.hasOwn(buildGoalDecisionSchema().properties,'execution'),false);
});
test('empty material bindings never allow unknown material and preserve free messages', () => {
 assert.equal(validateGoalDecision({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'stage-xyz'}},[]).ok,false);
 assert.equal(validateGoalDecision({status:'goal_ready',goal},[]).ok,true);
});
test('invalid/duplicate binding shapes fail before model', () => {
 for (const value of [{},[{stage_id:'x'},{stage_id:'x'}],[{stage_id:''}],[{stage_id:'x',text:'secret'}]]) {
  assert.throws(()=>normalizeGoalInput({...input,material_bindings:value}),e=>e.code==='VALIDATION_ERROR');
 }
});
const schema={type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string'}}};
const stateInput={request_id:'profile-case',conversation_revision:'full',conversation_history:{format:'messages',messages:[]},state_schema:schema,partner_profile:'x'.repeat(1600)+'WB: четыре года',extraction_instructions:'Различать факты профиля и договорённости',communication_plan:{version:1,stages:[]}};
test('full profile/instructions/plan reach extraction and count in explicit size budget',()=>{
 normalizeStateInput(stateInput);const prompt=renderStatePrompt(stateInput).messages.at(-1).content;
 assert.match(prompt,/WB: четыре года/);assert.match(prompt,/Различать факты/);assert.match(prompt,/communication_plan/);
 assert.equal(stateInputMetrics(stateInput).context_chars>1600,true);
});
test('oversized profile produces explicit error rather than context loss',async()=>{
 const r=await extractConversationState({...stateInput,partner_profile:'x'.repeat(120001)},ENV);
 assert.equal(r.data.error.code,'INPUT_TOO_LARGE');
});
test('REST and MCP expose structural material execution from the same handler',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({model:'fixture',choices:[{message:{content:JSON.stringify({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'stage-xyz'}})}}]}));
 try {
  const req=(path,body)=>new Request('https://worker.test'+path,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify(body)});
  const rest=await worker.fetch(req('/v1/conversations/next-goal',input),ENV);assert.equal(rest.status,200);assert.equal((await rest.json()).execution.stage_id,'stage-xyz');
  const mcp=await worker.fetch(req('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'evaluate_next_goal',arguments:input}}),ENV);
  const out=await mcp.json();assert.equal(out.result.structuredContent.execution.stage_id,'stage-xyz');
 } finally {globalThis.fetch=original;}
});
