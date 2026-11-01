'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {findCodex}=require('../hooks/availability.cjs');
const {AgentError,rpcFailure}=require('./agent-error.cjs');
const {normalizeQuestions,normalizeAnswer,asyncQuestions,asyncReply}=require('./user-input.cjs');
const {childEnvironment}=require('../child-environment.cjs');
function executable(file) {try {return path.isAbsolute(file)&&fs.statSync(file).isFile()&&(fs.accessSync(file,fs.constants.X_OK)===undefined);}catch{return false;}}
function resolveBinary(settings) {
  if(settings.binary) {if(!executable(settings.binary))throw new Error('客户端可执行文件不存在或不可执行');return settings.binary;}
  const file=settings.backend==='codex'?findCodex():[
    ...['agent','cursor-agent'].flatMap(name=>(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(dir=>path.join(dir,name))),
    path.join(os.homedir(),'.local/bin/agent'),path.join(os.homedir(),'.local/bin/cursor-agent')
  ].find(executable);
  if(!file)throw new Error(`未找到 ${settings.backend==='cursor'?'Cursor CLI，请安装 CLI 或指定路径':'Codex，请指定可执行文件'}`);
  return file;
}
function validateSettings(value,{requireCwd=true,checkPaths=true}={}) {
  if(!value||!['codex','cursor'].includes(value.backend))throw new Error('请选择 Codex 或 Cursor');
  const settings=Object.fromEntries(['backend','cwd','binary','configHome','profile'].map(key=>[key,typeof value[key]==='string'?value[key].trim():'']));
  const directory=file=>{try{return path.isAbsolute(file)&&fs.statSync(file).isDirectory();}catch{return false;}};
  if(requireCwd&&!settings.cwd)throw new Error('请选择存在的项目目录');
  if(settings.cwd){if(!directory(settings.cwd))throw new Error('请选择存在的项目目录');settings.cwd=fs.realpathSync(settings.cwd);}
  if(settings.configHome&&(!path.isAbsolute(settings.configHome)||(checkPaths&&!directory(settings.configHome))))throw new Error('Codex 配置目录必须是存在的绝对路径');
  if(settings.profile&&!/^[\w.-]{1,100}$/.test(settings.profile))throw new Error('Codex profile 名称无效');
  if(settings.binary&&(!path.isAbsolute(settings.binary)||(checkPaths&&!executable(settings.binary))))throw new Error('客户端路径必须指向可执行文件');
  return settings;
}
function startLocalAgent({settings,text,session,onSession=()=>{},onApproval=async()=>false,onUserInput,spawnImpl=spawn,timeoutMs=600000}) {
  let child,threadId=session||'',turnId='',cancelled=false,done=false,resolveResult,rejectResult,sequence=0,output='',buffer='',stage='spawn',turnFailure;
  const pending=new Map(),messages=new Map(),fileChanges=new Map(),userInputs=new Map();
  const promise=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  let timeout;
  function stopProcess() {
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    try {if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill();}catch {child.kill();}
    const processToStop=child;
    const escalation=setTimeout(()=>{if(processToStop.exitCode===null&&processToStop.signalCode===null){try{if(process.platform!=='win32'&&processToStop.pid)process.kill(-processToStop.pid,'SIGKILL');else processToStop.kill('SIGKILL');}catch{}}},2000);escalation.unref?.();
  }
  function finish(error,result) {
    if(done)return;done=true;clearTimeout(timeout);
    for(const controller of userInputs.values())controller.abort();userInputs.clear();
    for(const {reject,timer,method} of pending.values()){clearTimeout(timer);reject(new AgentError('CONNECTION',method));}pending.clear();
    stopProcess();error?rejectResult(error instanceof AgentError?error:new AgentError('UNKNOWN',stage)):resolveResult({text:result||'本轮没有返回文本结果。',session:threadId});
  }
  function send(value){if(!done&&child?.stdin.writable)child.stdin.write(JSON.stringify(value)+'\n');}
  function rpc(method,params) {
    if(method!=='turn/interrupt')stage=method;
    return new Promise((resolve,reject)=>{
      const id=++sequence;
      const timer=setTimeout(()=>{pending.delete(id);reject(new AgentError('RPC_TIMEOUT',method));},20000);timer.unref?.();
      pending.set(id,{resolve,reject,timer,method});send({id,method,params});
    });
  }
  async function askInput(key,questions,submit) {
    if(userInputs.has(key))return;
    if(!onUserInput)throw new AgentError('INTERACTION','turn');
    const controller=new AbortController();userInputs.set(key,controller);
    try{
      const response=await onUserInput({questions,signal:controller.signal});
      if(done||controller.signal.aborted)return;
      await submit(normalizeAnswer(response,questions));
    }finally{if(userInputs.get(key)===controller)userInputs.delete(key);controller.abort();}
  }
  async function receive(data) {
    if(done)return;
    if(data.id!==undefined&&!data.method) {
      const item=pending.get(data.id);if(!item)return;
      pending.delete(data.id);clearTimeout(item.timer);
      data.error?item.reject(rpcFailure(data.error,item.method)):item.resolve(data.result);return;
    }
    if(data.id!==undefined&&data.method) {
      const params=data.params||{};
      if(params.threadId!==threadId||(params.turnId&&turnId&&params.turnId!==turnId)){send({id:data.id,error:{code:-32602,message:'Unbound turn'}});return;}
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(data.method)) {
        const command=data.method.includes('commandExecution');
        const detail=command?params.command:fileChanges.get(params.itemId);
        // 缺失可审查内容或要求整个会话写权限时保守拒绝，不让一条确认变成长期授权。
        const reviewable=typeof detail==='string'&&detail.length>0&&detail.length<=8000&&!params.grantRoot;
        const accepted=reviewable&&await onApproval({kind:command?'command':'file',
          detail:[detail,params.reason,params.networkApprovalContext?`网络：${params.networkApprovalContext.protocol}://${params.networkApprovalContext.host}`:''].filter(Boolean).join('\n'),cwd:params.cwd||settings.cwd});
        send({id:data.id,result:{decision:accepted?'accept':'decline'}});
      } else if(data.method==='item/permissions/requestApproval')send({id:data.id,result:{permissions:{},scope:'turn'}});
      else if(data.method==='item/tool/requestUserInput'){
        if(!turnId||params.turnId!==turnId){send({id:data.id,error:{code:-32602,message:'Unbound turn'}});return;}
        // 阻塞式问题直接响应原 RPC 请求 ID，不能另开一轮或先用空答案结束请求。
        await askInput('request:'+data.id,normalizeQuestions(params.questions),response=>send({id:data.id,result:response}));
      }
      else send({id:data.id,error:{code:-32601,message:'Unsupported remote interaction'}});
      return;
    }
    const params=data.params||{};
    if(params.threadId!==threadId)return;
    // 客户端撤销请求后同步撤销微信提问，迟到的答案不能再交回该请求。
    if(data.method==='serverRequest/resolved'){const key='request:'+params.requestId;userInputs.get(key)?.abort();userInputs.delete(key);return;}
    if(data.method==='turn/started'){turnId=params.turn?.id||turnId;stage='turn';}
    if(data.method==='error'&&params.willRetry!==true&&(!params.turnId||!turnId||params.turnId===turnId))turnFailure=rpcFailure(params.error,'turn');
    if(data.method==='item/started'&&params.item?.type==='fileChange')fileChanges.set(params.item.id,(params.item.changes||[]).map(change=>`${change.path}\n${change.diff||''}`).join('\n'));
    if(data.method==='item/agentMessage/delta'&&(!params.turnId||!turnId||params.turnId===turnId)) {
      output+=typeof params.delta==='string'?params.delta:'';
      if(output.length>100000)finish(new AgentError('REPLY_LIMIT','turn'));
    }
    if(data.method==='item/completed'&&params.item?.type==='agentMessage'&&(!params.turnId||params.turnId===turnId)){
      messages.set(params.item.id,params.item.text||'');
      if(params.item.questions?.length){
        const questions=asyncQuestions(params.item),expectedTurnId=turnId;
        // 异步答案插入原轮次；由服务端核对 expectedTurnId，防止串入后续任务。
        await askInput('async:'+params.item.id,questions,response=>rpc('turn/steer',{threadId,expectedTurnId,input:[{type:'text',text:asyncReply(questions,response)}]}));
      }
    }
    if(data.method==='turn/completed'&&(!turnId||params.turn?.id===turnId)) {
      if(params.turn?.status!=='completed')finish(cancelled?new AgentError('CANCELLED','turn'):params.turn?.error?rpcFailure(params.turn.error,'turn'):turnFailure||new AgentError('TURN_FAILED','turn'));
      else finish(null,[...messages.values()].join('\n\n')||output);
    }
  }
  async function boot() {
    let binary;try{binary=resolveBinary(settings);}catch{throw new AgentError('BINARY','spawn');}
    const env=childEnvironment();
    if(settings.backend==='codex'&&settings.configHome)env.CODEX_HOME=settings.configHome;
    const args=settings.backend==='codex'?[...(settings.profile?['--profile',settings.profile]:[]),'app-server']:
      ['--mode','ask','--sandbox','enabled','--print','--output-format','json',...(session?['--resume',session]:[]),'--',text];
    child=spawnImpl(binary,args,{cwd:settings.cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    child.on('error',()=>finish(new AgentError('SPAWN','spawn')));
    child.stdin.on('error',()=>finish(new AgentError('CONNECTION',stage)));
    child.stderr.on('data',()=>{}); // 不转发客户端日志，避免包含认证和代理凭据。
    child.on('close',code=>{
      if(done)return;
      if(settings.backend==='cursor'&&code===0&&!cancelled) {
        try {
          const result=JSON.parse(buffer);
          if(result.is_error||typeof result.result!=='string')throw Error();
          threadId=result.session_id||session||'';if(threadId)onSession(threadId);finish(null,result.result);
        }catch {finish(new AgentError('CURSOR_RESULT','cursor'));}
      }else finish(new AgentError(cancelled?'CANCELLED':'EXIT',stage));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=chunk.toString();
      if(Buffer.byteLength(buffer)>2*1024*1024){finish(new AgentError('OUTPUT_LIMIT',stage));return;}
      if(settings.backend==='cursor')return;
      for(;;) {
        const index=buffer.indexOf('\n');if(index<0)break;
        const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        let data;try{data=JSON.parse(line);}catch{continue;}
        void receive(data).catch(()=>finish(new AgentError('INTERACTION',stage)));
      }
    });
    if(settings.backend==='cursor'){stage='cursor';child.stdin.end();return;}
    await rpc('initialize',{clientInfo:{name:'deepsleep-wechat',version:'0.1.0'},capabilities:{}});send({method:'initialized'});
    if(session) {
      const existing=await rpc('thread/read',{threadId:session,includeTurns:false});
      if(existing.thread?.id!==session||!existing.thread.cwd||fs.realpathSync(existing.thread.cwd)!==settings.cwd)throw new AgentError('PROJECT','thread/read');
      if(existing.thread.status?.type==='active')throw new AgentError('BUSY','thread/read');
    }
    // CLI 只授予所选项目写权限，额外操作逐次审批；续接不回传整段历史以免长会话超限。
    const params={cwd:settings.cwd,sandbox:'workspace-write',approvalPolicy:'on-request',approvalsReviewer:'user'};
    const result=await rpc(session?'thread/resume':'thread/start',{...params,...(session?{threadId:session,excludeTurns:true}:{ephemeral:false})});
    threadId=result?.thread?.id;
    if(!threadId)throw new AgentError('THREAD_ID',stage);
    if(session&&threadId!==session)throw new AgentError('THREAD_CHANGED',stage);
    onSession(threadId);
    const turn=await rpc('turn/start',{threadId,input:[{type:'text',text}],cwd:settings.cwd,
      approvalPolicy:'on-request',approvalsReviewer:'user',sandboxPolicy:{type:'workspaceWrite',writableRoots:[settings.cwd],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});turnId=turn?.turn?.id||turnId;
  }
  timeout=setTimeout(()=>finish(new AgentError('TIMEOUT',stage)),timeoutMs);timeout.unref?.();
  void boot().catch(error=>finish(error));
  return {promise,cancel(){cancelled=true;if(threadId&&turnId)void rpc('turn/interrupt',{threadId,turnId}).catch(()=>{});finish(new AgentError('CANCELLED',stage));}};
}
module.exports={executable,resolveBinary,validateSettings,startLocalAgent};
