'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {collectGit}=require('../src/reports/git.cjs');
test('Git collection strips DeepSleep management credentials from the real subprocess environment',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-report-git-env-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const gitBinary=(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,'git')).find(file=>fs.existsSync(file));
  execFileSync(gitBinary,['init','-q'],{cwd:directory});
  execFileSync(gitBinary,['-c','user.name=Fixture','-c','user.email=me@example.test','-c','commit.gpgsign=false','commit','--allow-empty','-m','fixture'],{cwd:directory,stdio:'ignore'});
  const log=path.join(directory,'environment.jsonl');
  fs.writeFileSync(path.join(directory,'git'),'#!/usr/bin/env node\n'+`
    const fs=require('node:fs'),{execFileSync}=require('node:child_process');
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({privateKeys:Object.keys(process.env).filter(key=>/^WHALE_/i.test(key)),path:process.env.PATH})+'\\n');
    process.stdout.write(execFileSync(${JSON.stringify(gitBinary)},process.argv.slice(2)));
  `,{mode:0o700});
  const values={PATH:directory+path.delimiter+process.env.PATH,WHALE_QUOTA_API_KEY:'fixture-quota',WHALE_REPORT_JENKINS_TOKEN:'fixture-jenkins'};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  Object.assign(process.env,values);
  const entries=await collectGit({path:directory,project:'fixture',authors:'me@example.test'},{since:0,until:Date.now()+1000});
  assert.equal(entries.length,1);
  const records=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(records.length,2);
  for(const record of records){assert.deepEqual(record.privateKeys,[]);assert.equal(record.path,values.PATH);}
});
test('real Git history filters exact authors, keeps stable commit IDs and never changes the worktree',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'whale-report-git-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:directory,encoding:'utf8'}).trim();git(['init','-q']);
  const dates=['2026-10-26T10:00:00+08:00','2026-10-26T11:00:00+08:00'];
  for(const [index,email] of ['me@example.test','someone@example.test'].entries()){
    execFileSync('git',['-c','user.name=Fixture','-c','user.email='+email,'-c','commit.gpgsign=false','commit','--allow-empty','-m',index?'其他人的改动':'完成工作\n\n验证通过'],
      {cwd:directory,env:{...process.env,GIT_AUTHOR_DATE:dates[index],GIT_COMMITTER_DATE:dates[index]},stdio:'ignore'});
  }
  fs.writeFileSync(path.join(directory,'untouched.txt'),'用户未提交内容');const before=git(['status','--porcelain']),head=git(['rev-parse','HEAD']);
  const source={path:directory,project:'测试项目',authors:'ME@example.test'},options={since:Date.parse('2026-10-25T00:00:00+08:00'),until:Date.parse('2026-10-27T00:00:00+08:00')};
  const first=await collectGit(source,options),again=await collectGit(source,options);
  assert.equal(first.length,1);assert.equal(first[0].title,'完成工作');assert.equal(first[0].details,'验证通过');assert.equal(first[0].date,'2026-10-26');assert.equal(first[0].sourceKey,again[0].sourceKey);
  assert.equal(git(['status','--porcelain']),before);assert.equal(git(['rev-parse','HEAD']),head);
  await assert.rejects(collectGit({...source,path:path.join(directory,'missing')},options),/不可访问/);
});
