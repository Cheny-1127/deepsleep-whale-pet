'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {startLocalAgent,validateSettings}=require('../src/agents/local-agent.cjs');
function fixture(t,backend='codex') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-agent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'fixture-agent'),log=path.join(dir,'wire.jsonl');
  fs.writeFileSync(binary,'#!/usr/bin/env node\n'+fs.readFileSync(path.join(__dirname,'fixtures/wechat-agent.cjs'),'utf8'),{mode:0o700});
  const children=[];
  const spawnImpl=(bin,args,options)=>{const child=spawn(bin,args,{...options,env:{...options.env,WHALE_AGENT_FIXTURE_LOG:log}});children.push(child);return child;};
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');});
  return {settings:validateSettings({backend,cwd:dir,binary,configHome:dir,profile:'existing-profile'}),spawnImpl,children,read:()=>fs.readFileSync(log,'utf8').trim().split('\n').map(line=>JSON.parse(line))};
}
test('Codex uses existing config and project write policy with user approval for extra permissions',async t=>{
  const f=fixture(t),sessions=[],approvals=[];
  const result=await startLocalAgent({...f,text:'approval',session:'old-session',onSession:id=>sessions.push(id),onApproval:async request=>{approvals.push(request);return true;}}).promise;
  assert.equal(result.text,'Codex fixture 结论😀');assert.deepEqual(sessions,['old-session']);assert.equal(approvals[0].detail,'fixture-read');
  const records=f.read();assert.deepEqual(records[0].args,['--profile','existing-profile','app-server']);assert.equal(records[0].configHome,f.settings.configHome);
  const resume=records.find(item=>item.method==='thread/resume');assert.equal(resume.params.threadId,'old-session');assert.equal(resume.params.sandbox,'workspace-write');assert.equal(resume.params.approvalPolicy,'on-request');assert.equal(resume.params.approvalsReviewer,'user');
  const start=records.find(item=>item.method==='turn/start');assert.deepEqual(start.params.sandboxPolicy,{type:'workspaceWrite',writableRoots:[f.settings.cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true});
  assert.ok(!('modelProvider' in resume.params)&&!('model' in resume.params));assert.equal(records.find(item=>item.approval).approval.decision,'accept');
});
test('Cursor runs Ask mode and uses its existing CLI session without force flags',async t=>{
  const f=fixture(t,'cursor');const result=await startLocalAgent({...f,text:'排查',session:'cursor-old'}).promise;
  assert.equal(result.text,'Cursor fixture 结论😀');assert.equal(result.session,'cursor-fixture');
  const args=f.read()[0].args;assert.deepEqual(args,['--mode','ask','--sandbox','enabled','--print','--output-format','json','--resume','cursor-old','--','排查']);assert.ok(!args.includes('--force'));
});
test('Cursor treats option-like messages as a single prompt after the option terminator',async t=>{
  for(const text of ['--sandbox=disabled','--mode=agent','--help','- 第一项\n- 第二项']) {
    const f=fixture(t,'cursor');await startLocalAgent({...f,text}).promise;
    const args=f.read()[0].args;
    assert.equal(args.at(-2),'--');assert.equal(args.at(-1),text);
    assert.deepEqual(args.slice(0,-2),['--mode','ask','--sandbox','enabled','--print','--output-format','json']);
  }
});
test('unapproved Codex requests receive decline rather than a session grant',async t=>{
  const f=fixture(t);await startLocalAgent({...f,text:'approval'}).promise;
  assert.equal(f.read().find(item=>item.approval).approval.decision,'decline');
});
test('CLI questions return the users answer to the original request instead of an empty response',async t=>{
  const f=fixture(t),questions=[];
  await startLocalAgent({...f,text:'question',onUserInput:async request=>{questions.push(request);return {answers:{mode:{answers:['修改代码']}}};}}).promise;
  assert.equal(questions.length,1);assert.equal(questions[0].questions[0].question,'如何处理？');
  assert.deepEqual(f.read().find(item=>item.userInput).userInput,{answers:{mode:{answers:['修改代码']}}});
});
test('CLI asynchronous questions steer only their active turn with the original question ID',async t=>{
  const f=fixture(t);
  const result=await startLocalAgent({...f,text:'async-question',timeoutMs:1000,onUserInput:async request=>({answers:{[request.questions[0].id]:{answers:['修改代码']}}})}).promise;
  assert.equal(result.text.includes('Codex fixture'),true);
  const input=f.read().find(item=>item.steeringInput).steeringInput;
  assert.equal(input.expectedTurnId,'turn-fixture');assert.equal(input.threadId,'codex-fixture');
  assert.match(input.input[0].text,/<send_user_message_question_reply>/);assert.ok(input.input[0].text.includes('async-item'));assert.ok(input.input[0].text.includes('修改代码'));
});
test('CLI request withdrawal aborts its question callback and foreign turns cannot request answers',async t=>{
  const f=fixture(t);let signal;
  await startLocalAgent({...f,text:'withdrawn-question',onUserInput:request=>{signal=request.signal;return new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve(null),{once:true}));}}).promise;
  assert.equal(signal?.aborted,true);assert.equal(f.read().some(item=>item.userInput),false);
  const other=fixture(t);await startLocalAgent({...other,text:'foreign-question',onUserInput:()=>assert.fail('foreign turn question')}).promise;
  assert.equal(other.read().find(item=>item.userInput).userInput.code,-32602);
});
test('cancel and timeout terminate only the agent process owned by this request',async t=>{
  const f=fixture(t);const task=startLocalAgent({...f,text:'hang'});
  await new Promise(resolve=>setTimeout(resolve,100));task.cancel();await assert.rejects(task.promise,/停止/);
  const child=f.children[0];if(child.exitCode===null)await new Promise(resolve=>child.once('close',resolve));assert.ok(child.signalCode||child.exitCode!==null);
  await assert.rejects(startLocalAgent({...f,text:'hang',timeoutMs:150}).promise,/十分钟/);
});
test('invalid binding paths cannot be passed through to a client process',()=>{
  assert.throws(()=>validateSettings({backend:'codex',cwd:'/does-not-exist'}),/项目目录/);
  assert.throws(()=>validateSettings({backend:'shell',cwd:process.cwd()}),/Codex/);
  assert.throws(()=>validateSettings({backend:'codex',cwd:process.cwd(),profile:'a; command'}),/profile/);
});
test('a foreign project, busy thread or changed resume identity cannot start a new turn',async t=>{
  for(const [session,error]of [['foreign-cwd',/项目不一致/],['busy-thread',/正在运行/],['replaced-thread',/不同的会话/]]) {
    const f=fixture(t);await assert.rejects(startLocalAgent({...f,text:'must not execute',session}).promise,error);
    assert.equal(f.read().filter(item=>item.method==='turn/start').length,0);
  }
});
test('resuming a long desktop conversation excludes history from the response and still continues the same thread',async t=>{
  const f=fixture(t);const result=await startLocalAgent({...f,text:'继续修改项目代码',session:'large-history'}).promise;
  assert.equal(result.text,'Codex fixture 结论😀');assert.equal(result.session,'large-history');
  const wire=f.read();assert.equal(wire.find(item=>item.method==='thread/resume').params.excludeTurns,true);
  assert.equal(wire.find(item=>item.method==='turn/start').params.threadId,'large-history');
});
test('RPC and failed turns report their stage and safe reason without leaking server details',async t=>{
  for(const [session,text,stage,code]of [['rpc-resume-failed','test','thread/resume',-32600],[undefined,'turn-rpc-failed','turn/start',-32602],[undefined,'turn-failed','turn',undefined]]) {
    const f=fixture(t);
    await assert.rejects(startLocalAgent({...f,text,session}).promise,error=>{
      assert.equal(error.stage,stage);assert.equal(error.rpcCode,code);
      assert.ok(!JSON.stringify(error).includes('private-api-key'));assert.ok(!error.message.includes('private-api-key'));assert.ok(!error.message.includes('private.example'));
      if(text==='turn-failed')assert.match(error.message,/认证/);
      return true;
    });
  }
});
