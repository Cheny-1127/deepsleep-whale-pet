'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {desktopFixture}=require('./fixtures/codex-desktop.cjs');
const {startDesktopAgent}=require('../src/agents/codex-desktop.cjs');
const {startWechatAgent}=require('../src/agents/wechat-agent.cjs');
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('desktop condition timed out');}
async function setup(t,options={}) {
  const home=fs.mkdtempSync('/tmp/whale-desktop-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const desktop=await desktopFixture({home,...options});t.after(()=>desktop.close());
  const settings={backend:'codex',cwd:fs.realpathSync(home),configHome:home,profile:'must-not-override-desktop'};
  return {desktop,run:extra=>startDesktopAgent({settings,session:'desktop-fixture',text:'test',...extra})};
}
test('forwards exact text to the desktop owner, inherits settings and returns only this turn final answer',async t=>{
  const {desktop}=await setup(t,{autoComplete:true});
  const text='test\n保留原文 /help  😀  ',sessions=[];
  const result=await startWechatAgent({settings:{backend:'codex',cwd:fs.realpathSync(path.dirname(path.dirname(desktop.socketPath))),configHome:path.dirname(path.dirname(desktop.socketPath))},session:'desktop-fixture',transport:'desktop',text,onSession:id=>sessions.push(id),spawnImpl:()=>assert.fail('must never spawn CLI for desktop forwarding')}).promise;
  assert.deepEqual(result,{text:'桌面回复😀',session:'desktop-fixture'});assert.deepEqual(sessions,['desktop-fixture']);
  const requests=desktop.wire.filter(m=>m.type==='request');
  assert.deepEqual(requests.map(m=>m.method),['initialize','thread-owner-discovery','thread-follower-start-turn']);
  const start=requests.at(-1);assert.equal(start.version,2);assert.equal(start.targetClientId,'desktop-owner');
  assert.equal(start.params.conversationId,'desktop-fixture');assert.deepEqual(start.params.turnStart.context,{inheritThreadSettings:true});
  assert.deepEqual(start.params.turnStart.request,{threadId:'desktop-fixture',input:[{type:'text',text,text_elements:[]}],clientUserMessageId:start.params.turnStart.request.clientUserMessageId});
  assert.ok(start.params.turnStart.request.clientUserMessageId);
});
test('waits for the desktop current turn to finish and never reports its old answer as the new reply',async t=>{
  const {desktop,run}=await setup(t,{busy:true});let settled=false;
  const task=run();task.promise.finally(()=>{settled=true;}).catch(()=>{});
  await until(()=>desktop.wire.some(m=>m.params?.following));
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);assert.equal(settled,false);
  desktop.idle();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  assert.equal(settled,false);desktop.complete('本次 test 的回复');assert.equal((await task.promise).text,'本次 test 的回复');
});
test('accepts canonical patches, ignores other chats and completes only the correlated turn',async t=>{
  const {desktop,run}=await setup(t);const task=run();
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.send({type:'broadcast',method:'thread-stream-state-changed',version:11,sourceClientId:'other-owner',params:{hostId:'local',conversationId:'another-chat',change:{type:'snapshot',revision:99,conversationState:{id:'another-chat'}}}});
  desktop.patch([{op:'replace',path:['turnHistory','history','entitiesByKey','current','items'],value:[{type:'agentMessage',id:'result',phase:'final_answer',text:'精确回复'}]},{op:'replace',path:['turnHistory','history','entitiesByKey','current','status'],value:'completed'}]);
  assert.equal((await task.promise).text,'精确回复');
});
test('cancel while waiting leaves the desktop running turn alone; cancel after forwarding interrupts only its own turn',async t=>{
  const first=await setup(t,{busy:true}),waiting=first.run();
  await until(()=>first.desktop.wire.some(m=>m.params?.following));waiting.cancel();await assert.rejects(waiting.promise,e=>e.code==='CANCELLED');
  assert.equal(first.desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
  const second=await setup(t),task=second.run();await until(()=>second.desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  task.cancel();await assert.rejects(task.promise,e=>e.code==='CANCELLED');
  const stop=second.desktop.wire.find(m=>m.method==='thread-follower-interrupt-turn');
  assert.equal(stop.version,4);assert.equal(stop.params.expectedTurnId,'forwarded-turn');assert.equal(stop.targetClientId,'desktop-owner');
});
test('desktop disconnect after submission does not reconnect or replay and reports uncertain delivery',async t=>{
  const {desktop,run}=await setup(t),task=run();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  for(const socket of desktop.connections)socket.destroy();
  await assert.rejects(task.promise,e=>e.code==='DELIVERY_UNKNOWN');
  assert.equal(desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);
});
test('unexpected protocol, changed owner, patch gaps and unsafe paths fail without forwarding or returning history',async t=>{
  for(const failure of ['version','owner','gap','prototype']) {
    const {desktop,run}=await setup(t,{busy:true}),task=run();await until(()=>desktop.wire.some(m=>m.params?.following));
    if(failure==='version')desktop.snapshot({version:99});
    if(failure==='owner')desktop.snapshot({sourceClientId:'unrelated-owner'});
    if(failure==='gap')desktop.broadcast({type:'patches',baseRevision:500,revision:501,patches:[]});
    if(failure==='prototype')desktop.patch([{op:'add',path:['__proto__','polluted'],value:true}]);
    await assert.rejects(task.promise,e=>e.code==='DESKTOP_PROTOCOL');
    assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);assert.equal({}.polluted,undefined);
  }
});
test('no desktop endpoint or foreign project fails clearly without creating an endpoint or starting CLI',async t=>{
  const home=fs.mkdtempSync('/tmp/whale-desktop-missing-');t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  await assert.rejects(startDesktopAgent({settings:{cwd:home,configHome:home},session:'selected',text:'test'}).promise,e=>e.code==='DESKTOP_UNAVAILABLE');assert.equal(fs.existsSync(path.join(home,'ipc')),false);
  const {run}=await setup(t,{cwd:'/'});await assert.rejects(run().promise,e=>e.code==='PROJECT');
});
test('only approvals in the forwarded turn are reviewed once and explicit decisions return to the pinned desktop owner',async t=>{
  const {desktop,run}=await setup(t),reviews=[];
  const task=run({onApproval:async request=>{reviews.push(request);return true;}});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:'old-request',method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'previous-turn',itemId:'old-tool',command:'never approve this'}}];
  desktop.snapshot();assert.equal(reviews.length,0);
  desktop.state.requests.push({id:7,method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-tool',command:'pwd',cwd:desktop.state.cwd}});
  desktop.snapshot();desktop.snapshot();
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-command-approval-decision'));
  assert.deepEqual(reviews,[{kind:'command',detail:'pwd',cwd:desktop.state.cwd}]);
  const decision=desktop.wire.find(m=>m.method==='thread-follower-command-approval-decision');
  assert.equal(decision.targetClientId,'desktop-owner');assert.equal(decision.version,1);assert.deepEqual(decision.params,{conversationId:'desktop-fixture',requestId:7,decision:'accept'});
  desktop.complete();await task.promise;
});
test('unreviewable desktop approvals are declined once without waiting for WeChat',async t=>{
  const cases=[
    {name:'missing-command',params:{}},
    {name:'blank-command',params:{command:' \n '}},
    {name:'oversized-command',params:{command:'x'.repeat(8001)}},
    {name:'oversized-reason',params:{command:'pwd',reason:'x'.repeat(8001)}},
    {name:'session-grant',params:{command:'pwd',grantRoot:'/tmp'}},
    {name:'missing-file-item',file:true,params:{}},
    {name:'missing-file-diff',file:true,params:{},changes:[{path:'fixture.txt'}]},
    {name:'missing-file-path',file:true,params:{},changes:[{diff:'+fixture'}]},
    {name:'partial-file-diffs',file:true,params:{},changes:[{path:'one.txt',diff:'+one'},{path:'two.txt'}]},
    {name:'oversized-file-diff',file:true,params:{},changes:[{path:'fixture.txt',diff:'x'.repeat(8001)}]},
    {name:'no-review-handler',params:{command:'pwd'},noHandler:true}
  ];
  for(const value of cases)await t.test(value.name,async t=>{
    const {desktop,run}=await setup(t);
    const task=run(value.noHandler?{}:{onApproval:()=>assert.fail('unreviewable request must not ask for approval')});
    task.promise.catch(()=>{});t.after(()=>{task.cancel();});
    await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
    if(value.changes)desktop.state.turnHistory.history.entitiesByKey.current.items=[{id:'own-tool',type:'fileChange',changes:value.changes}];
    desktop.state.requests=[{id:value.name,method:value.file?'item/fileChange/requestApproval':'item/commandExecution/requestApproval',
      params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-tool',...value.params}}];
    desktop.snapshot();desktop.snapshot();
    const method=value.file?'thread-follower-file-approval-decision':'thread-follower-command-approval-decision';
    await until(()=>desktop.wire.some(m=>m.method===method));
    const decisions=desktop.wire.filter(m=>m.method===method);assert.equal(decisions.length,1);
    assert.equal(decisions[0].targetClientId,'desktop-owner');
    assert.deepEqual(decisions[0].params,{conversationId:'desktop-fixture',requestId:value.name,decision:'decline'});
    desktop.complete();await task.promise;
  });
});
test('a complete file diff remains reviewable and returns its decision to the original desktop request',async t=>{
  const {desktop,run}=await setup(t),reviews=[];
  const task=run({onApproval:async value=>{reviews.push(value);return true;}});task.promise.catch(()=>{});t.after(()=>task.cancel());
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.turnHistory.history.entitiesByKey.current.items=[{id:'own-file',type:'fileChange',changes:[{path:'fixture.txt',diff:'-before\n+after'}]}];
  desktop.state.requests=[{id:'file-request',method:'item/fileChange/requestApproval',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-file',reason:'fixture'}}];
  desktop.snapshot();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-file-approval-decision'));
  assert.equal(reviews.length,1);assert.equal(reviews[0].detail,'fixture.txt\n-before\n+after\nfixture');
  const decision=desktop.wire.find(m=>m.method==='thread-follower-file-approval-decision');
  assert.equal(decision.targetClientId,'desktop-owner');assert.deepEqual(decision.params,{conversationId:'desktop-fixture',requestId:'file-request',decision:'accept'});
  desktop.complete();await task.promise;
});
test('a desktop-resolved request cannot be approved again by a late WeChat response',async t=>{
  const {desktop,run}=await setup(t);let decide;
  const task=run({onApproval:()=>new Promise(resolve=>{decide=resolve;})});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:'own-request',method:'item/commandExecution/requestApproval',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'own-tool',command:'pwd'}}];
  desktop.snapshot();await until(()=>decide);
  desktop.state.requests=[];desktop.snapshot();decide(true);desktop.complete();await task.promise;
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-command-approval-decision'),false);
});
test('desktop questions submit one answer to their pinned owner and original request',async t=>{
  const {desktop,run}=await setup(t),asked=[];
  const task=run({onUserInput:async request=>{asked.push(request);return {answers:{mode:{answers:['修复']}}};}});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:17,method:'item/tool/requestUserInput',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',itemId:'q',questions:[{id:'mode',question:'怎样处理？',options:[{label:'分析'},{label:'修复'}]}]}}];
  desktop.snapshot();desktop.snapshot();await until(()=>desktop.wire.some(m=>m.method==='thread-follower-submit-user-input'));
  assert.equal(asked.length,1);assert.equal(asked[0].questions[0].question,'怎样处理？');
  const response=desktop.wire.find(m=>m.method==='thread-follower-submit-user-input');assert.equal(response.version,1);assert.equal(response.targetClientId,'desktop-owner');
  assert.deepEqual(response.params,{conversationId:'desktop-fixture',requestId:17,response:{answers:{mode:{answers:['修复']}}}});
  desktop.complete();await task.promise;
});
test('desktop withdrawal aborts the question and late answers are never submitted',async t=>{
  const {desktop,run}=await setup(t);let answer,signal;
  const task=run({onUserInput:request=>{signal=request.signal;return new Promise(resolve=>{answer=resolve;});}});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.requests=[{id:'q',method:'item/tool/requestUserInput',params:{threadId:'desktop-fixture',turnId:'forwarded-turn',questions:[{id:'mode',question:'怎样处理？'}]}}];
  desktop.snapshot();await until(()=>answer);
  desktop.state.requests=[];desktop.snapshot();await until(()=>signal.aborted);answer({answers:{mode:{answers:['晚到答案']}}});
  desktop.complete();await task.promise;assert.equal(desktop.wire.some(m=>m.method==='thread-follower-submit-user-input'),false);
});
test('desktop asynchronous agent questions use question IDs and steer the same active turn',async t=>{
  const {desktop,run}=await setup(t),asked=[];
  const task=run({onUserInput:async request=>{asked.push(request);return {answers:{[request.questions[0].id]:{answers:['修复']}}};}});
  void task.promise.catch(()=>{});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.state.turnHistory.history.entitiesByKey.old.items.push({id:'old-question',type:'agentMessage',questions:[{title:'不要转发旧问题',options:['旧选项']}]});
  desktop.patch([{op:'replace',path:['turnHistory','history','entitiesByKey','current','items'],value:[{id:'async-q',type:'agentMessage',phase:'commentary',text:'问题',questions:[{title:'怎样处理？',options:['分析','修复']}]}]}]);
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-steer-turn'));
  assert.equal(asked.length,1);assert.equal(asked[0].questions[0].id,JSON.stringify(['request_user_input_async','async-q',0]));
  const response=desktop.wire.find(m=>m.method==='thread-follower-steer-turn');assert.equal(response.version,1);assert.equal(response.targetClientId,'desktop-owner');
  assert.equal(response.params.conversationId,'desktop-fixture');assert.match(response.params.input[0].text,/<send_user_message_question_reply>/);assert.ok(response.params.input[0].text.includes('修复'));
  const restore=response.params.restoreMessage;
  assert.equal(restore?.id,response.params.clientUserMessageId);assert.equal(restore?.text,response.params.input[0].text);
  assert.deepEqual(restore?.context.workspaceRoots,[fs.realpathSync(desktop.state.cwd)]);assert.equal(restore?.context.prompt,restore.text);
  await until(()=>desktop.state.turnHistory.history.entitiesByKey.current.items.some(item=>item.type==='steeringUserMessage'&&item.status==='accepted'));
  desktop.complete();await task.promise;
});
test('desktop answers to an async question withdraw the WeChat prompt before any late steer',async t=>{
  const {desktop,run}=await setup(t);let answer,signal;
  const task=run({onUserInput:request=>{signal=request.signal;return new Promise(resolve=>{answer=resolve;});}});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  const items=desktop.state.turnHistory.history.entitiesByKey.current.items;
  items.push({id:'async-q',type:'agentMessage',questions:[{title:'怎样处理？',options:['分析','修复']}]});desktop.snapshot();await until(()=>answer);
  items.push({id:'desktop-answer',type:'steeringUserMessage',status:'accepted',input:[{type:'text',text:'<send_user_message_question_reply>'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','async-q',0]),question:'怎样处理？',answer:'分析'}])+'</send_user_message_question_reply>'}]});
  desktop.snapshot();await until(()=>signal.aborted);answer({answers:{[JSON.stringify(['request_user_input_async','async-q',0])]:{answers:['修复']}}});
  desktop.complete();await task.promise;assert.equal(desktop.wire.some(m=>m.method==='thread-follower-steer-turn'),false);
});
test('waiting timeout does not interrupt somebody elses desktop turn, and rejected delivery never leaks raw errors',async t=>{
  const first=await setup(t,{busy:true});await assert.rejects(first.run({timeoutMs:30}).promise,e=>e.code==='TIMEOUT');
  assert.equal(first.desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'||m.method==='thread-follower-start-turn'),false);
  const second=await setup(t);await assert.rejects(second.run({text:'desktop-rejected'}).promise,e=>e.code==='DELIVERY_UNKNOWN'&&!e.message.includes('private-api-key')&&!e.message.includes('private.example'));
});

test('persists the submission identity before sending and the server turn ID before completing',async t=>{
  const {desktop,run}=await setup(t),checkpoints=[];
  const task=run({timeoutMs:200,onCheckpoint:checkpoint=>{
    if(checkpoint.submitted&&!checkpoint.turnId)assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);
    checkpoints.push(structuredClone(checkpoint));
  }});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  desktop.complete();await task.promise;
  const request=desktop.wire.find(m=>m.method==='thread-follower-start-turn');
  assert.ok(checkpoints.some(x=>x.messageId===request.params.turnStart.request.clientUserMessageId&&x.submitted&&!x.turnId));
  assert.deepEqual(checkpoints.at(-1),{messageId:request.params.turnStart.request.clientUserMessageId,submitted:true,turnId:'forwarded-turn'});
});
test('checkpoint save failure prevents desktop submission',async t=>{
  const {desktop,run}=await setup(t);
  await assert.rejects(run({timeoutMs:200,onCheckpoint:()=>{throw Error('private storage error');}}).promise,e=>e.code==='TRACKING_STORE'&&!e.message.includes('private'));
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);
});
test('restart reads only the saved completed turn even when a later turn exists',async t=>{
  const {desktop,run}=await setup(t);
  desktop.state.turnHistory.history.entitiesByKey.recovered={turnId:'saved-turn',status:'completed',params:{clientUserMessageId:'saved-message'},items:[{type:'agentMessage',phase:'commentary',text:'不发进度'},{type:'agentMessage',phase:'final_answer',text:'原任务完整结果'}]};
  desktop.state.turnHistory.history.entitiesByKey.current={turnId:'later-turn',status:'completed',params:{clientUserMessageId:'later-message'},items:[{type:'agentMessage',phase:'final_answer',text:'不要转发后续对话'}]};
  const result=await run({timeoutMs:200,recovering:true,checkpoint:{messageId:'saved-message',turnId:'saved-turn',submitted:true}}).promise;
  assert.equal(result.text,'原任务完整结果');assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);
});
test('recovery can correlate an accepted message whose start response was lost and continue watching it',async t=>{
  const {desktop,run}=await setup(t),checkpoints=[];
  desktop.state.turnHistory.history.entitiesByKey.current={turnId:'accepted-turn',status:'inProgress',params:{clientUserMessageId:'saved-message'},items:[]};desktop.state.threadRuntimeStatus.type='active';
  const task=run({timeoutMs:200,recovering:true,checkpoint:{messageId:'saved-message',turnId:'',submitted:true},onCheckpoint:value=>checkpoints.push(value)});
  await until(()=>checkpoints.some(x=>x.turnId==='accepted-turn'));
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);
  desktop.complete('后来完成');assert.equal((await task.promise).text,'后来完成');
});
test('unknown, conflicting and interrupted recovered turns never submit or interrupt work',async t=>{
  for(const kind of ['missing','conflicting','interrupted','unsubmitted'])await t.test(kind,async t=>{
    const {desktop,run}=await setup(t);
    desktop.state.turnHistory.history.entitiesByKey.current={turnId:kind==='conflicting'?'different-turn':'saved-turn',status:kind==='interrupted'?'interrupted':'completed',params:{clientUserMessageId:kind==='missing'?'unrelated':'saved-message'},items:[]};
    const checkpoint={messageId:'saved-message',turnId:kind==='missing'?'absent':'saved-turn',submitted:kind!=='unsubmitted'};
    await assert.rejects(run({timeoutMs:200,recovering:true,checkpoint}).promise,e=>e.code===(kind==='interrupted'?'TURN_INTERRUPTED':kind==='conflicting'?'DESKTOP_PROTOCOL':'RECOVERY_UNKNOWN'));
    assert.equal(desktop.wire.some(m=>['thread-follower-start-turn','thread-follower-interrupt-turn'].includes(m.method)),false);
  });
});
test('detaching for shutdown preserves the desktop turn for recovery',async t=>{
  const {desktop,run}=await setup(t),task=run();
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  assert.equal(typeof task.detach,'function');task.detach();await assert.rejects(task.promise,e=>e.code==='DELIVERY_UNKNOWN');
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
});
test('recovery timeout releases tracking without interrupting the original desktop turn',async t=>{
  const {desktop,run}=await setup(t);
  desktop.state.turnHistory.history.entitiesByKey.current={turnId:'saved-turn',status:'inProgress',params:{clientUserMessageId:'saved-message'},items:[]};desktop.state.threadRuntimeStatus.type='active';
  await assert.rejects(run({recovering:true,checkpoint:{messageId:'saved-message',turnId:'saved-turn',submitted:true},timeoutMs:40}).promise,e=>e.code==='RECOVERY_UNKNOWN');
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
});
test('temporary disconnect restores the same desktop result without resubmitting text',async t=>{
  const {desktop}=await setup(t),home=path.dirname(path.dirname(desktop.socketPath));
  const task=startWechatAgent({settings:{backend:'codex',cwd:fs.realpathSync(home),configHome:home},session:'desktop-fixture',transport:'desktop',text:'一次执行',timeoutMs:500,retryDelayMs:5,reconnectTimeoutMs:200});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  for(const socket of desktop.connections)socket.destroy();desktop.complete('断线期间完成');
  assert.equal((await task.promise).text,'断线期间完成');
  assert.equal(desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);
  assert.ok(desktop.wire.filter(m=>m.params?.following===true).length>=2);
});

test('recovery can be cancelled before validation without interrupting a saved or unrelated turn',async t=>{
  const {desktop,run}=await setup(t);
  const task=run({recovering:true,checkpoint:{messageId:'saved-message',turnId:'saved-turn',submitted:true}});task.cancel();
  await assert.rejects(task.promise,e=>e.code==='CANCELLED');
  assert.equal(desktop.wire.some(m=>m.method==='thread-follower-interrupt-turn'),false);
});
test('repeated connection failures are bounded and never resend an already submitted desktop message',async t=>{
  const {desktop}=await setup(t),home=path.dirname(path.dirname(desktop.socketPath));
  const task=startWechatAgent({settings:{backend:'codex',cwd:fs.realpathSync(home),configHome:home},session:'desktop-fixture',transport:'desktop',text:'只发一次',timeoutMs:400,retryDelayMs:5,reconnectTimeoutMs:35});
  await until(()=>desktop.wire.some(m=>m.method==='thread-follower-start-turn'));
  await desktop.close();await assert.rejects(task.promise,e=>e.code==='RECOVERY_UNKNOWN');
  assert.equal(desktop.wire.filter(m=>m.method==='thread-follower-start-turn').length,1);
});
test('a recovery connection that never responds also expires within the reconnect window',async t=>{
  const net=require('node:net'),{once}=require('node:events'),home=fs.mkdtempSync('/tmp/whale-stalled-');
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));fs.mkdirSync(path.join(home,'ipc'),{mode:0o700});
  const sockets=new Set(),server=net.createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});});
  const socketPath=path.join(home,'ipc/ipc.sock');server.listen(socketPath);await once(server,'listening');fs.chmodSync(socketPath,0o600);
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  const task=startWechatAgent({settings:{backend:'codex',cwd:fs.realpathSync(home),configHome:home},session:'desktop-fixture',transport:'desktop',recovering:true,
    checkpoint:{messageId:'saved-message',turnId:'saved-turn',submitted:true},timeoutMs:500,reconnectTimeoutMs:35});
  const started=Date.now();await assert.rejects(task.promise,e=>e.code==='RECOVERY_UNKNOWN');
  assert.ok(Date.now()-started<300,'a silent connection must not wait for the full task deadline');
});
test('recovered questions are revalidated against the original live request before returning an answer',async t=>{
  const {desktop,run}=await setup(t);let answer;
  desktop.state.turnHistory.history.entitiesByKey.current={turnId:'saved-turn',status:'inProgress',params:{clientUserMessageId:'saved-message'},items:[]};desktop.state.threadRuntimeStatus.type='active';
  desktop.state.requests=[{id:'live-question',method:'item/tool/requestUserInput',params:{threadId:'desktop-fixture',turnId:'saved-turn',questions:[{id:'mode',question:'仍在等待的问题'}]}}];
  const task=run({recovering:true,checkpoint:{messageId:'saved-message',turnId:'saved-turn',submitted:true},onUserInput:()=>new Promise(resolve=>{answer=resolve;})});
  await until(()=>answer);assert.equal(desktop.wire.some(m=>m.method==='thread-follower-submit-user-input'),false);
  answer({answers:{mode:{answers:['继续']}}});await until(()=>desktop.wire.some(m=>m.method==='thread-follower-submit-user-input'));
  const request=desktop.wire.find(m=>m.method==='thread-follower-submit-user-input');assert.equal(request.params.requestId,'live-question');assert.equal(request.targetClientId,'desktop-owner');
  desktop.complete();await task.promise;assert.equal(desktop.wire.some(m=>m.method==='thread-follower-start-turn'),false);
});
