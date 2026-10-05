import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateStateEvidence, resolveEvidencePointer} from '../src/state-evidence.mjs';
import {extractConversationState, normalizeStateInput} from '../src/state-handler.mjs';
import {renderStatePrompt} from '../src/state-prompt.mjs';

const evidenceSchema={type:'object',additionalProperties:false,required:['requirements'],properties:{requirements:{type:'array',items:{type:'object',additionalProperties:false,required:['evidence'],properties:{evidence:{type:'array',items:{type:'object',additionalProperties:false,required:['source_id','quote'],properties:{source_id:{type:'string'},quote:{type:'string'}}}}}}}}};
const input={request_id:'evidence-fixture',conversation_history:{format:'messages',messages:[{id:'m1',speaker:'partner',text:'Да, готов выполнить.'}]},partner_profile:{format:'text',text:'Опыт WB:\nтри года рекламы.'},context:{factual_context:{vacancy_id:'123'},instructions:'Пригласить на интервью'},evidence_source_refs:{profile:'/partner_profile',context:'/context/factual_context'},state_schema:evidenceSchema};
const state=(source_id,quote)=>({requirements:[{evidence:[{source_id,quote}]}]});

test('evidence references validate original message and multiline profile text without duplicated source input',()=>{
 for(const [id,quote] of [['m1','готов выполнить'],['profile','Опыт WB:\nтри года'],['context','123']]) assert.equal(validateStateEvidence(state(id,quote),input).ok,true);
 assert.equal(validateStateEvidence(state('profile','Опыт WB: три года'),input).ok,false);
 assert.equal(validateStateEvidence(state('context','Пригласить на интервью'),input).ok,false);
 assert.equal(validateStateEvidence(state('absent','готов выполнить'),input).ok,false);
 assert.equal(validateStateEvidence(state('profile','  '),input).ok,false);
 const privateSource='privatecandidate@example.test';
 assert.ok(!JSON.stringify(validateStateEvidence(state(privateSource,'invented private text'),input).problems).includes(privateSource));
});
test('generic schemas and callers without opt-in provenance retain existing behavior',()=>{
 const {evidence_source_refs,...legacy}=input;
 assert.equal(validateStateEvidence(state('custom','external caller source'),legacy).ok,true);
 assert.equal(validateStateEvidence({evidence:[{source_message_id:'custom',quote:'caller-specific shape'}]},input).ok,true);
});
test('JSON pointers resolve own properties safely and support escaped segments',()=>{
 assert.equal(resolveEvidencePointer({'a/b':{'~key':'original'}},'/a~1b/~0key'),'original');
 assert.equal(resolveEvidencePointer(Object.create({inherited:'bad'}),'/inherited'),undefined);
 assert.equal(resolveEvidencePointer({},'/__proto__/polluted'),undefined);
 for(const pointer of ['plain','/bad~2']) assert.throws(()=>normalizeStateInput({...input,evidence_source_refs:{profile:pointer}}));
});
test('profile text is rendered with its original newlines for verbatim extraction',()=>{
 assert.ok(renderStatePrompt(input).messages[1].content.includes(input.partner_profile.text));
});
test('bad evidence is repaired inside the existing state loop before returning success',async()=>{
 const original=globalThis.fetch;const bodies=[];globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);bodies.push(body);const result=state('profile',bodies.length===1?'Опыт WB: три года':'Опыт WB:\nтри года');return new Response(JSON.stringify({model:'fixture',choices:[{message:{content:JSON.stringify({state:result})}}]}));};
 try{const result=await extractConversationState(input,{LLM_LADDER_URL:'http://fixture',LLM_LADDER_TOKEN:'fixture'});assert.equal(result.isError,false,JSON.stringify(result.data));assert.equal(result.data.generation.attempts,2);assert.equal(bodies.length,2);assert.match(bodies[1].messages.at(-1).content,/copy a nonempty quote exactly/);}finally{globalThis.fetch=original;}
});
test('two bad provenance answers return typed rejection without leaking quote text',async()=>{
 const original=globalThis.fetch;let calls=0;const privateQuote='SECRET invented quote';globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({state:state('profile',privateQuote)})}}]}));};
 try{const result=await extractConversationState(input,{LLM_LADDER_URL:'http://fixture'});assert.equal(result.isError,true);assert.equal(result.data.error.code,'STATE_REJECTED');assert.equal(calls,2);assert.ok(!JSON.stringify(result.data.error).includes(privateQuote));assert.match(JSON.stringify(result.data.error),/requirements\[0\]/);}finally{globalThis.fetch=original;}
});
