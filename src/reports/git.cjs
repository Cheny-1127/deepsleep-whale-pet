'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process'),{promisify}=require('node:util'),{createHash}=require('node:crypto');
const {dateKey}=require('./model.cjs');
const {childEnvironment}=require('../child-environment.cjs');
const exec=promisify(execFile);
function safe(message){return Object.assign(Error(message),{reportSafe:true});}
async function collectGit(source,{since,until,signal}={}){
  let directory;try{directory=fs.realpathSync(source.path);if(!path.isAbsolute(directory))throw Error();}catch{throw safe('Git 仓库目录不可访问，请检查本机路径');}
  const authors=new Set(source.authors.split(',').map(value=>value.trim().toLowerCase()).filter(Boolean));if(!authors.size)throw safe('请配置要采集的 Git 作者邮箱');
  const options={cwd:directory,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,signal,env:{...childEnvironment(),GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}};
  try{
    const {stdout:root}=await exec('git',['-c','core.fsmonitor=false','rev-parse','--show-toplevel'],options);
    directory=fs.realpathSync(root.trim());
    // 不 fetch/pull，不执行用户 shell，也不按提交说明推断已部署；只读本地可达提交。
    const {stdout}=await exec('git',['-c','core.fsmonitor=false','log','--all','--no-show-signature','--since='+new Date(since).toISOString(),'--until='+new Date(until).toISOString(),
      '--max-count=2001','-z','--format=%H%x00%ae%x00%an%x00%ct%x00%s%x00%b'],{...options,cwd:directory});
    const fields=stdout.split('\0');if(fields.at(-1)==='')fields.pop();if(fields.length%6)throw Error();
    if(fields.length/6>2000)throw safe('Git 回溯范围超过 2000 条提交，请缩短回溯天数');
    const repoKey=createHash('sha256').update(directory).digest('hex'),result=[];
    for(let i=0;i<fields.length;i+=6){const [sha,email,author,seconds,title,body]=fields.slice(i,i+6),at=Number(seconds)*1000;
      if(!/^[0-9a-f]{40,64}$/.test(sha)||!Number.isSafeInteger(at))throw Error();
      if(at<since||at>until||!authors.has(email.toLowerCase()))continue;
      result.push({source:'git',sourceKey:`git:${repoKey}:${sha}`,title:title.slice(0,200)||'Git 提交',project:source.project,details:body.trim().slice(0,4000),date:dateKey(at),status:'done',
        evidence:`${source.project} · ${sha.slice(0,12)} · ${author}`,sourceMeta:{sha,repository:directory,author,email,committedAt:at}});
    }
    return result;
  }catch(error){if(error.reportSafe)throw error;if(signal?.aborted)throw error;throw safe('读取 Git 提交失败，请确认目录是可访问的本地 Git 仓库');}
}
module.exports={collectGit};
