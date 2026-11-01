'use strict';
const {spawn}=require('node:child_process');
const os=require('node:os');
const {resolveBinary,validateSettings}=require('./local-agent.cjs');
const {childEnvironment}=require('../child-environment.cjs');
// 仅查询公共元信息接口；正文、预览、认证与客户端日志不进入网关快照或微信列表。
function queryCodex(settings,method,params,{spawnImpl=spawn,timeoutMs=15000,signal}={}) {
  return new Promise((resolve,reject)=>{
    let child,buffer='',done=false;
    const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);child?.kill();error?reject(error):resolve(result);};
    const abort=()=>finish(new Error('查询已取消'));
    const timer=setTimeout(()=>finish(new Error('客户端查询超时，请检查本机 Codex')),timeoutMs);
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    try {
      if(settings.backend!=='codex'||!['thread/list','thread/read'].includes(method))throw new Error('此客户端不支持共享对话查询');
      settings=validateSettings(settings,{requireCwd:false});
      const env=childEnvironment();if(settings.configHome)env.CODEX_HOME=settings.configHome;
      child=spawnImpl(resolveBinary(settings),[...(settings.profile?['--profile',settings.profile]:[]),'app-server'],{cwd:settings.cwd||os.homedir(),env,stdio:['pipe','pipe','pipe']});
      const send=value=>{if(!done)child.stdin.write(JSON.stringify(value)+'\n');};
      child.stderr.on('data',()=>{});
      child.on('error',()=>finish(new Error('无法启动 Codex 查询')));
      child.on('close',()=>finish(new Error('Codex 查询连接已关闭')));
      child.stdin.on('error',()=>finish(new Error('Codex 查询连接已关闭')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        buffer+=chunk;if(Buffer.byteLength(buffer)>4*1024*1024){finish(new Error('客户端查询结果过大'));return;}
        for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          let data;try{data=JSON.parse(line);}catch{continue;}
          if(data.method&&data.id!==undefined){send({id:data.id,error:{code:-32601,message:'Read-only metadata client'}});continue;}
          if(data.id!==1&&data.id!==2)continue;
          if(data.error){finish(new Error('Codex 不支持本次查询，请检查版本和配置'));return;}
          if(data.id===1){send({method:'initialized'});send({id:2,method,params});}
          else finish(null,data.result);
        }
      });
      send({id:1,method:'initialize',params:{clientInfo:{name:'deepsleep-catalog',version:'0.1.0'},capabilities:{}}});
    }catch(error){finish(error);}
  });
}
function projectThread(thread) {
  if(!thread||typeof thread.id!=='string'||typeof thread.cwd!=='string'||thread.parentThreadId)return null;
  const source=thread.source;
  if(!['cli','vscode','appServer'].includes(source)||thread.threadSource==='subagent')return null;
  return {id:thread.id,cwd:thread.cwd,name:typeof thread.name==='string'&&thread.name.trim()?thread.name.trim().slice(0,120):'未命名对话',
    updatedAt:thread.updatedAt,status:thread.status?.type||'notLoaded',source};
}
async function listCodexThreads(settings,{cursor=null,cwd,limit=20,signal,spawnImpl}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error('对话查询数量无效');
  const result=await queryCodex(settings,'thread/list',{limit,cursor,sortKey:'updated_at',sortDirection:'desc',archived:false,
    sourceKinds:['cli','vscode','appServer'],modelProviders:[],...(cwd?{cwd}:{})},{signal,spawnImpl});
  if(!Array.isArray(result?.data))throw new Error('Codex 返回的对话列表无法识别');
  return {threads:result.data.map(projectThread).filter(Boolean),nextCursor:typeof result.nextCursor==='string'?result.nextCursor:null};
}
async function readCodexThread(settings,id,{signal,spawnImpl}={}) {
  const result=await queryCodex(settings,'thread/read',{threadId:id,includeTurns:false},{signal,spawnImpl});
  const thread=projectThread(result?.thread);
  if(!thread||thread.id!==id)throw new Error('此实例中未找到可用对话，请重新选择');
  return thread;
}
module.exports={queryCodex,listCodexThreads,readCodexThread,projectThread};
