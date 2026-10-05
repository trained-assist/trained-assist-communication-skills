import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluateNextGoal} from '../src/goal-handler.mjs';
import {generateNextMessage} from '../src/handler.mjs';
const ENV={LLM_LADDER_URL:'http://fixture-ladder',LLM_LADDER_TOKEN:'fixture'};
const quote='Для звонка предлагаю 7 октября в 11:00.';
const history={format:'messages',messages:[{id:'proposal',speaker:'partner',text:quote}]};
const objective='Принять предложение к сведению и проверить свою возможность перед подтверждением.';
const expectedGoal={instruction:objective,required_points:[],forbidden_points:['Не подтверждать доступность без фактов']};
async function withModel(callback){const original=globalThis.fetch;const calls=[];globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);const isGoal=body['response_format']?.json_schema?.name==='next_communication_goal';if(isGoal){assert.match(body.messages[0].content,/required_points contains ONLY already confirmed factual information/);assert.match(body.response_format.json_schema.schema.properties.goal.properties.required_points.description,/No communicative directives/);}const content=isGoal?JSON.stringify({status:'goal_ready',goal:expectedGoal}):'Спасибо за предложенное время. Проверю свою доступность перед подтверждением.';return new Response(JSON.stringify({model:'fixture',choices:[{message:{content}}]}),{status:200});};try{return await callback(calls);}finally{globalThis.fetch=original;}}
test('generic goal→writer acknowledgement directives do not become unsupported required facts',async()=>withModel(async calls=>{
 const goal=await evaluateNextGoal({request_id:'directive-goal',conversation_revision:'rev',conversation_objective:objective,conversation_state:{proposal:{evidence:[{source_id:'proposal',quote}]},source_speakers:{proposal:'partner'}}},ENV);assert.equal(goal.isError,false);assert.equal(goal.data.generation.prompt_version,'gp5');
 const writer=await generateNextMessage({request_id:'directive-writer',context_revision:'rev',goal:goal.data.goal,language:'ru',communication_style:{instructions:'Кратко'},conversation_history:history},ENV);assert.equal(writer.isError,false);assert.equal(writer.data.status,'generated');assert.equal(calls.length,2);assert.equal(writer.data.message_text,'Спасибо за предложенное время. Проверю свою доступность перед подтверждением.');assert.deepEqual(calls[1].messages.some(m=>m.content.includes(objective)),true);
}));
test('unconfirmed factual required point still returns needs_context before model; guard unchanged',async()=>withModel(async calls=>{
 const writer=await generateNextMessage({request_id:'missing-fact',context_revision:'rev',goal:{instruction:'Сообщить подтверждённую доступность',required_points:['Рекрутер подтвердил доступность в семь утра']},language:'ru',communication_style:{instructions:'Кратко'},conversation_history:history},ENV);assert.equal(writer.data.status,'needs_context');assert.deepEqual(writer.data.missing_fields,['Рекрутер подтвердил доступность в семь утра']);assert.equal(calls.length,0);
}));
