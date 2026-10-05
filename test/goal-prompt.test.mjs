import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderGoalPrompt} from '../src/goal-prompt.mjs';
import {buildGoalDecisionSchema} from '../src/goal-schema.mjs';
import {evaluateNextGoal} from '../src/goal-handler.mjs';

const input={request_id:'goal-prompt-fixture',conversation_revision:'revision',conversation_objective:'Выяснить оставшийся вопрос по сценарию.',conversation_state:{summary:'Нужен следующий вопрос.'},language:'ru'};
test('goal decision schema remains in the prompt when the provider drops response_format',()=>{
 for(const material_bindings of [undefined,[],[{stage_id:'material-stage'}]]) {
  const args={...input,...(material_bindings===undefined?{}:{material_bindings})};
  const prompt=renderGoalPrompt(args).messages.at(-1).content;
  assert.ok(prompt.includes(JSON.stringify(buildGoalDecisionSchema(material_bindings??null))));
  assert.match(prompt,/write_message execution contains only type/);
  assert.match(prompt,/terminal wait\/no_matching_option/);
 }
});
test('goal handler supplies the same decision contract in text and provider schema',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(init.body);const schema=body.response_format.json_schema.schema;assert.ok(body.messages.at(-1).content.includes(JSON.stringify(schema)));return new Response(JSON.stringify({model:'fixture',choices:[{message:{content:JSON.stringify({status:'wait',goal:null,execution:null})}}]}));};
 try{const result=await evaluateNextGoal({...input,material_bindings:[{stage_id:'material-stage'}]},{LLM_LADDER_URL:'http://fixture'});assert.equal(result.isError,false,JSON.stringify(result.data));assert.equal(result.data.status,'wait');assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
