'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {queryCodex,listCodexThreads,readCodexThread,projectThread}=require('../src/agents/codex-catalog.cjs');
test('metadata client does not inherit DeepSleep management credentials',async t=>{
  const values={WHALE_QUOTA_API_KEY:'fixture-quota',WHALE_REPORT_JENKINS_TOKEN:'fixture-jenkins'};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  Object.assign(process.env,values);let environment;
  await assert.rejects(queryCodex({backend:'codex',binary:process.execPath,cwd:process.cwd(),configHome:os.tmpdir()},'thread/list',{},
    {spawnImpl:(_bin,_args,options)=>{environment=options.env;throw Error('fixture stopped before spawn');}}),/fixture stopped/);
  for(const key of Object.keys(values))assert.equal(environment[key],undefined,key);
  assert.equal(environment.CODEX_HOME,os.tmpdir());assert.equal(environment.PATH,process.env.PATH);
});
test('catalog queries the selected configuration and all interactive sources without exposing previews or running tasks',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-catalog-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'codex-fixture'),log=path.join(dir,'wire.jsonl');
  fs.writeFileSync(binary,'#!/usr/bin/env node\n'+fs.readFileSync(path.join(__dirname,'fixtures/wechat-agent.cjs'),'utf8'),{mode:0o700});
  const children=[];t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');});
  const spawnImpl=(bin,args,options)=>{const child=spawn(bin,args,{...options,env:{...options.env,WHALE_AGENT_FIXTURE_LOG:log}});children.push(child);return child;};
  const client={backend:'codex',binary,cwd:dir,configHome:dir,profile:'existing'};
  const list=await listCodexThreads(client,{spawnImpl,cursor:'next',cwd:dir});
  assert.equal(list.threads[0].name,'桌面对话');assert.equal(list.threads[0].cwd,fs.realpathSync(dir));assert.ok(!JSON.stringify(list).includes('private-history'));
  const thread=await readCodexThread(client,'desktop-fixture',{spawnImpl});assert.equal(thread.id,'desktop-fixture');assert.ok(!('preview' in thread));
  const records=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records[0].args,['--profile','existing','app-server']);assert.equal(records[0].configHome,dir);
  const params=records.find(item=>item.method==='thread/list').params;assert.deepEqual(params.sourceKinds,['cli','vscode','appServer']);assert.deepEqual(params.modelProviders,[]);assert.equal(params.cursor,'next');assert.equal(params.cwd,dir);
  assert.equal(records.find(item=>item.method==='thread/read').params.includeTurns,false);
  assert.ok(!records.some(item=>['thread/start','thread/resume','turn/start'].includes(item.method)));
});
test('subagent metadata is excluded and missing names never fall back to prompt contents',()=>{
  const thread={id:'id',cwd:'/',source:'vscode',preview:'private text'};
  assert.equal(projectThread({...thread,parentThreadId:'parent'}),null);assert.equal(projectThread({...thread,source:'subAgent'}),null);
  assert.equal(projectThread(thread).name,'未命名对话');
});
