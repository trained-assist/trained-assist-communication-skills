import {test} from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {buildGoalDecisionSchema,buildGoalResultSchema,validateGoalDecision} from '../src/goal-schema.mjs';
const ajv=new Ajv({strict:false,allowUnionTypes:true});
const bindings=[{stage_id:'task'}];
const goal={instruction:'Ответить на вопрос кандидата'};
const cases=[
 ['normal writer',{status:'goal_ready',goal,execution:{type:'write_message'}},true],
 ['writer cannot carry stage',{status:'goal_ready',goal,execution:{type:'write_message',stage_id:'task'}},false],
 ['writer cannot carry resend flag',{status:'goal_ready',goal,execution:{type:'write_message',resend_requested:false}},false],
 ['saved material',{status:'goal_ready',goal,execution:{type:'send_material',stage_id:'task'}},true],
 ['requested resend',{status:'goal_ready',goal,execution:{type:'send_material',stage_id:'task',resend_requested:true}},true],
 ['send requires binding',{status:'goal_ready',goal,execution:{type:'send_material'}},false],
 ['unknown binding',{status:'goal_ready',goal,execution:{type:'send_material',stage_id:'unknown'}},false],
 ['wait omits goal',{status:'wait'},true],
 ['wait permits null goal',{status:'wait',goal:null,execution:null},true],
 ['terminal does not send',{status:'wait',execution:{type:'send_material',stage_id:'task'}},false],
 ['terminal does not write',{status:'no_matching_option',execution:{type:'write_message'}},false],
 ['terminal does not carry goal',{status:'wait',goal},false],
 ['ready requires goal',{status:'goal_ready'},false],
 ['ready cannot have null goal',{status:'goal_ready',goal:null},false],
];
for(const [name,value,expected]of cases)test('model schema agrees with semantic guard: '+name,()=>{
 const schemaCheck=ajv.compile(buildGoalDecisionSchema(bindings));
 assert.equal(schemaCheck(value),expected,JSON.stringify(schemaCheck.errors));
 assert.equal(validateGoalDecision(value,bindings).ok,expected);
});
test('empty bindings and legacy consumers cannot invent material execution',()=>{
 const empty=ajv.compile(buildGoalDecisionSchema([]));
 assert.equal(empty({status:'goal_ready',goal,execution:{type:'write_message'}}),true);
 assert.equal(empty({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'task'}}),false);
 const legacy=ajv.compile(buildGoalDecisionSchema());assert.equal(legacy({status:'goal_ready',goal}),true);assert.equal(legacy({status:'goal_ready',goal,execution:null}),false);
});
test('public result schema accepts the actual normalized resend result',()=>{
 const decision=validateGoalDecision({status:'goal_ready',goal,execution:{type:'send_material',stage_id:'task',resend_requested:true}},bindings);
 const result={...decision.value,requires_message:true,request_id:'fixture',conversation_revision:'rev'};
 const check=ajv.compile(buildGoalResultSchema());assert.equal(check(result),true,JSON.stringify(check.errors));
 assert.equal(check({...result,execution:{type:'write_message',stage_id:'task'}}),false);
 assert.equal(check({...result,execution:{type:'send_material'}}),false);
});
