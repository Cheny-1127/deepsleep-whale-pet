'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {createMessageSubscriptions, INTERVAL} = require('../src/channels/message-subscriptions.cjs');
const {xUsername} = require('../src/channels/x-posts.cjs');
const turn = () => new Promise(setImmediate);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-subscriptions-')), calls = [], jobs = new Set(), services = [];
  let now = Date.parse('2026-10-22T12:00:00+08:00'), response = async username => [post(1,username)], translator = async text => '中文：' + text;
  const translationCalls = [];
  const clock = {now:() => now, setTimeout(fn,ms) {const job = {fn,at:now + ms,ms};jobs.add(job);return job;},clearTimeout:job => jobs.delete(job)};
  function post(offset,username = 'thsottiaux') {
    return {id:String((BigInt(now - 600000 + offset) - 1288834974657n) << 22n),username,text:'动态 ' + offset};
  }
  const create = () => {
    const service = createMessageSubscriptions({dataDir:dir,clock,readPosts:(username,options) => {calls.push({username,...options});return response(username,options);},
      translateText:(text,options) => {translationCalls.push({text,...options});return translator(text,options);}});
    services.push(service);return service;
  };
  t.after(() => {services.forEach(s => s.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,clock,jobs,calls,post,create,service:create(),setResponse:fn => {response = fn;},translationCalls,setTranslator:fn => {translator = fn;},
    async advance(ms) {now += ms;for (const job of [...jobs]) if (job.at <= now) {jobs.delete(job);job.fn();}await turn();await turn();}};
}
test('X handles and supplied post links normalize, while foreign URLs and reserved paths are rejected', () => {
  for (const value of ['@ThSottiaux','thsottiaux','https://x.com/thsottiaux','https://x.com/thsottiaux/status/2113162277688070445?s=20','twitter.com/thsottiaux']) assert.equal(xUsername(value),'thsottiaux');
  for (const value of ['https://evil.test/thsottiaux','https://x.com.evil.test/thsottiaux','https://user:pass@x.com/thsottiaux','https://x.com:444/thsottiaux','http://x.com/thsottiaux','https://x.com/home','https://x.com/thsottiaux/anything','a'.repeat(16),null,'../x']) assert.throws(() => xUsername(value));
});
test('display names survive refresh, cache clear and restart without affecting reading or translation',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');
  f.setResponse(async()=>[{...f.post(1),displayName:'  Tibo\n  示例  '}]);await s.refresh();
  assert.equal(s.snapshot().accounts[0].displayName,'Tibo 示例');assert.equal(s.snapshot().posts[0].displayName,'Tibo 示例');
  await s.translate({username:'thsottiaux',id:f.post(1).id});s.markRead(null);
  f.setResponse(async()=>[f.post(1)]);await s.refresh();
  assert.equal(s.snapshot().accounts[0].displayName,'Tibo 示例');assert.ok(s.snapshot().posts[0].translation);assert.equal(s.summary().unread,0);
  f.setResponse(async()=>[{...f.post(1),displayName:'新昵称'}]);await s.refresh();
  assert.equal(s.snapshot().accounts[0].displayName,'新昵称');assert.ok(s.snapshot().posts[0].translation);
  s.clearCache();s.close();const restarted=f.create();
  assert.equal(restarted.snapshot().accounts[0].displayName,'新昵称');assert.equal(restarted.snapshot().posts.length,0);
});
test('first sync is unread, persisted cache is safe and restart retains read progress', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  assert.equal(s.snapshot().posts.length,1);assert.equal(s.summary().unread,1);s.markRead(null);
  assert.equal(s.snapshot().posts[0].url,`https://x.com/thsottiaux/status/${f.post(1).id}`);
  f.setResponse(async () => [f.post(2),f.post(1)]);await s.refresh();assert.equal(s.summary().unread,1);
  s.close();const restarted = f.create();assert.equal(restarted.summary().unread,1);assert.equal(restarted.snapshot().posts.length,2);
  assert.equal(fs.statSync(path.join(f.dir,'message-subscriptions.json')).mode & 0o777,0o600);
});
test('legacy cache becomes unread once, and reading after migration survives restart',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');await s.refresh();s.markRead(null);s.close();
  const file=path.join(f.dir,'message-subscriptions.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.version=1;fs.writeFileSync(file,JSON.stringify(saved));
  const upgraded=f.create();assert.equal(upgraded.snapshot().posts[0].unread,true);
  upgraded.markRead({username:'thsottiaux',id:f.post(1).id});upgraded.close();
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,2);
  const restarted=f.create();assert.equal(restarted.summary().unread,0);await restarted.refresh();assert.equal(restarted.summary().unread,0);
});
test('full posts are not overwritten by later truncated previews, and translations remain valid',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');await s.refresh();const value={username:'thsottiaux',id:f.post(1).id};
  await s.translate(value);const original=s.snapshot().posts[0];s.markRead(value);
  f.setResponse(async()=>[{...f.post(1),text:'short preview',truncated:true}]);await s.refresh();
  const result=s.snapshot().posts[0];assert.equal(result.text,original.text);assert.equal(result.truncated,false);
  assert.deepEqual(result.translation,original.translation);assert.equal(result.unread,false);
});
test('deleting a post removes source, translation and unread from disk, and refresh or restart cannot restore it',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');s.add('openai');await s.refresh();
  const value={username:'thsottiaux',id:f.post(1).id};await s.translate(value);s.deletePost(value);
  assert.equal(s.summary().unread,1);assert.equal(s.snapshot().posts.length,1);assert.equal(s.snapshot().posts[0].username,'openai');
  const saved=JSON.parse(fs.readFileSync(path.join(f.dir,'message-subscriptions.json'),'utf8')).accounts.find(a=>a.username===value.username);
  assert.deepEqual(saved.posts,[]);assert.deepEqual(saved.unreadIds,[]);assert.deepEqual(saved.deletedIds,[value.id]);
  await s.refresh();assert.equal(s.snapshot().posts.length,1);s.close();
  const restarted=f.create();await restarted.refresh();assert.equal(restarted.snapshot().posts.length,1);
  restarted.clearCache();await restarted.refresh();assert.equal(restarted.snapshot().posts.length,1);
  assert.throws(()=>restarted.deletePost(value),/不存在/);
});
test('legacy deletion history is bounded without restoring deleted posts across refresh, clear and restart',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');
  f.setResponse(async()=>[f.post(1),f.post(1200)]);await s.refresh();s.close();
  const file=path.join(f.dir,'message-subscriptions.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.accounts[0].deletedIds=Array.from({length:1100},(_,i)=>f.post(i+2).id);
  fs.writeFileSync(file,JSON.stringify(saved));const original=fs.readFileSync(file,'utf8');
  const upgraded=f.create();assert.equal(fs.readFileSync(file,'utf8'),original,'loading must not rewrite the existing file');
  upgraded.setRemark({username:'thsottiaux',remark:'保留配置'});
  let account=JSON.parse(fs.readFileSync(file,'utf8')).accounts[0];
  assert.equal(account.deletedIds.length,1000);assert.equal(account.deletedThroughId,f.post(101).id);
  assert.equal(new Set(account.deletedIds).size,1000);
  f.setResponse(async()=>[f.post(1200),f.post(102),f.post(101),f.post(2),{...f.post(1),text:'保留的旧缓存仍可更新'}]);
  await upgraded.refresh();assert.deepEqual(upgraded.snapshot().posts.map(p=>p.id),[f.post(1200).id,f.post(1).id]);
  assert.equal(upgraded.snapshot().posts[1].text,'保留的旧缓存仍可更新');
  const beforeDelete=fs.readFileSync(file,'utf8');fs.mkdirSync(file+'.tmp');
  assert.throws(()=>upgraded.deletePost({username:'thsottiaux',id:f.post(1200).id}),/保存失败/);
  assert.equal(fs.readFileSync(file,'utf8'),beforeDelete);assert.equal(upgraded.snapshot().posts.length,2);
  fs.rmdirSync(file+'.tmp');upgraded.deletePost({username:'thsottiaux',id:f.post(1200).id});
  account=JSON.parse(fs.readFileSync(file,'utf8')).accounts[0];
  assert.equal(account.deletedIds.length,1000);assert.equal(account.deletedThroughId,f.post(102).id);
  // 已缓存且早于截止线的帖子仍可删除，不能把截止线倒退。
  upgraded.deletePost({username:'thsottiaux',id:f.post(1).id});
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).accounts[0].deletedThroughId,f.post(102).id);
  upgraded.clearCache();upgraded.close();const restarted=f.create();
  f.setResponse(async()=>[f.post(1201),f.post(1200),f.post(102),f.post(2),f.post(1)]);await restarted.refresh();
  assert.deepEqual(restarted.snapshot().posts.map(p=>p.id),[f.post(1201).id]);
  restarted.remove('thsottiaux');restarted.add('thsottiaux');await restarted.refresh();
  assert.equal(restarted.snapshot().posts.length,5,'removing and readding the subscription resets deletion history');
});
test('an invalid deletion cutoff preserves the original subscription file and blocks writes',t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');s.close();
  const file=path.join(f.dir,'message-subscriptions.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.accounts[0].deletedThroughId='invalid';fs.writeFileSync(file,JSON.stringify(saved));
  const original=fs.readFileSync(file,'utf8'),restarted=f.create();
  assert.match(restarted.snapshot().storeError,/无法读取/);assert.throws(()=>restarted.add('openai'),/无法读取/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
test('deleting during an in-flight refresh or translation prevents late content from returning',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');await s.refresh();let readDone,translateDone;
  f.setResponse(()=>new Promise(resolve=>{readDone=resolve;}));
  f.setTranslator(()=>new Promise(resolve=>{translateDone=resolve;}));
  const translation=s.translate({username:'thsottiaux',id:f.post(1).id}),refresh=s.refresh();await turn();
  s.deletePost({username:'thsottiaux',id:f.post(1).id});assert.equal(f.translationCalls[0].signal.aborted,true);
  translateDone('迟到译文');readDone([f.post(2),f.post(1)]);await Promise.all([translation,refresh]);
  assert.deepEqual(s.snapshot().posts.map(p=>p.id),[f.post(2).id]);assert.equal(s.summary().unread,1);
  assert.equal(s.snapshot().posts[0].translation,undefined);
});
test('failed post deletion leaves memory, disk and running translation intact',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');await s.refresh();let done;
  f.setTranslator(()=>new Promise(resolve=>{done=resolve;}));const task=s.translate({username:'thsottiaux',id:f.post(1).id});await turn();
  const file=path.join(f.dir,'message-subscriptions.json'),before=fs.readFileSync(file,'utf8');
  fs.mkdirSync(file+'.tmp');assert.throws(()=>s.deletePost({username:'thsottiaux',id:f.post(1).id}),/保存失败/);
  assert.equal(s.snapshot().posts.length,1);assert.equal(s.summary().unread,1);assert.equal(f.translationCalls[0].signal.aborted,false);
  assert.equal(fs.readFileSync(file,'utf8'),before);fs.rmdirSync(file+'.tmp');done('保留译文');await task;
  assert.equal(s.snapshot().posts[0].translation.text,'保留译文');
});
test('clear cache retains account, read state and the high-water mark, including after restart', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();s.markRead(null);
  f.setResponse(async () => [f.post(2),f.post(1)]);await s.refresh();
  s.markRead({username:'thsottiaux',id:f.post(2).id});s.clearCache();
  assert.equal(s.snapshot().posts.length,0);assert.equal(s.snapshot().accounts.length,1);
  s.close();const restarted = f.create();await restarted.refresh();assert.equal(restarted.summary().unread,0);
  f.setResponse(async () => [f.post(3),f.post(2),f.post(1)]);await restarted.refresh();
  assert.deepEqual(restarted.snapshot().posts.filter(p => p.unread).map(p => p.id),[f.post(3).id]);
  restarted.markRead(null);assert.equal(restarted.summary().unread,0);
});
test('cache clear also restores an existing unread flag when the same post is fetched again', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  f.setResponse(async () => [f.post(2)]);await s.refresh();s.clearCache();await s.refresh();
  assert.equal(s.summary().unread,1);assert.equal(s.snapshot().posts[0].unread,true);
});
test('cache is bounded to the newest hundred unique posts per account', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  f.setResponse(async () => Array.from({length:100},(_,i) => f.post(i + 1)));await s.refresh();assert.equal(s.summary().unread,100);s.markRead(null);
  f.setResponse(async () => Array.from({length:100},(_,i) => f.post(i + 51)));await s.refresh();
  const posts = s.snapshot().posts;assert.equal(posts.length,100);
  assert.equal(posts[0].id,f.post(150).id);assert.equal(posts.at(-1).id,f.post(51).id);assert.equal(s.summary().unread,50);
});
test('hourly work survives restart and a long sleep without replaying missed intervals', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');s.start();await turn();await turn();assert.equal(f.calls.length,1);
  await f.advance(INTERVAL / 2);assert.equal(f.calls.length,1);s.close();
  const restarted = f.create();restarted.start();await turn();assert.equal(f.calls.length,1);
  await f.advance(INTERVAL / 2);assert.equal(f.calls.length,2);
  await f.advance(INTERVAL * 8);await restarted.checkDue();assert.equal(f.calls.length,3);
  assert.equal(f.jobs.size,1);assert.equal([...f.jobs][0].ms,INTERVAL);
});
test('account errors preserve cache and first eventual success marks fetched posts unread', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  f.setResponse(async () => {throw Error('private diagnostics');});await s.refresh();assert.ok(s.snapshot().accounts[0].error);
  assert.ok(!JSON.stringify(s.snapshot()).includes('private diagnostics'));
  f.setResponse(async () => [f.post(2)]);await s.refresh();assert.equal(s.summary().unread,1);
  f.setResponse(async () => {throw Object.assign(Error(),{code:'X_PUBLIC_UNAVAILABLE'});});await s.refresh();
  assert.equal(s.snapshot().posts.length,1);assert.match(s.snapshot().accounts[0].error,/公开页面/);
});
test('accounts run serially, failures do not prevent other accounts, and pause and removal persist', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');s.add('OpenAI');
  let active = 0;
  f.setResponse(async username => {assert.equal(active++,0);await turn();active--;if (username === 'thsottiaux') throw Error();return [f.post(1,username)];});
  const first = s.refresh();assert.equal(s.refresh(),first);await first;
  assert.deepEqual(f.calls.map(c => c.username),['thsottiaux','openai']);assert.equal(s.snapshot().posts.length,1);
  s.setEnabled({username:'thsottiaux',enabled:false});await s.refresh();assert.equal(f.calls.at(-1).username,'openai');
  s.remove('openai');s.close();const restarted = f.create();assert.equal(restarted.snapshot().accounts[0].enabled,false);
  assert.equal(restarted.snapshot().posts.length,0);assert.throws(() => restarted.add('THSOTTIAUX'),/已在/);
});
test('clear, pause, remove and shutdown cancel late responses instead of restoring cleared content', async t => {
  for (const action of ['clear','pause','remove','close']) {
    const f = fixture(t), s = f.service;s.add('thsottiaux');let done;
    f.setResponse(() => new Promise(resolve => {done = resolve;}));
    const task = s.refresh();await turn();
    if (action === 'clear') s.clearCache();if (action === 'pause') s.setEnabled({username:'thsottiaux',enabled:false});
    if (action === 'remove') s.remove('thsottiaux');if (action === 'close') s.close();
    assert.equal(f.calls[0].signal.aborted,true);done([f.post(1)]);await task;assert.equal(s.snapshot().posts.length,0);
  }
});
test('pausing or deleting another account does not cancel the active account or defer its hourly check', async t => {
  for (const action of ['pause','remove']) {
    const f = fixture(t), s = f.service;s.add('thsottiaux');s.add('openai');let done;
    f.setResponse(() => new Promise(resolve => {done = resolve;}));
    const task = s.refresh();await turn();
    if (action === 'pause') s.setEnabled({username:'openai',enabled:false});else s.remove('openai');
    assert.equal(f.calls[0].signal.aborted,false);
    done([f.post(1)]);await task;
    assert.equal(s.snapshot().posts.length,1);assert.deepEqual(f.calls.map(c => c.username),['thsottiaux']);
    assert.ok(s.snapshot().accounts[0].checkedAt);
  }
});
test('failed saves preserve file and memory, back off instead of busy-looping, and invalid files stay untouched', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');
  const file = path.join(f.dir,'message-subscriptions.json'), before = fs.readFileSync(file,'utf8');
  fs.mkdirSync(file + '.tmp');assert.throws(() => s.remove('thsottiaux'),/保存失败/);
  assert.equal(s.snapshot().accounts.length,1);assert.equal(fs.readFileSync(file,'utf8'),before);
  s.start();await turn();assert.equal(f.calls.length,0);assert.equal([...f.jobs][0].ms,INTERVAL);
  fs.rmdirSync(file + '.tmp');s.close();fs.writeFileSync(file,'broken fixture');
  const broken = f.create();assert.match(broken.snapshot().storeError,/无法读取/);assert.throws(() => broken.add('openai'),/无法读取/);
  broken.start();await turn();assert.equal(fs.readFileSync(file,'utf8'),'broken fixture');assert.equal(f.calls.length,0);
});
test('malformed and foreign-author responses never overwrite good posts or open arbitrary URLs', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();const good = s.snapshot().posts;
  for (const result of [[{...f.post(2),username:'openai'}],[{...f.post(2),id:'javascript:alert(1)'}],{},Array(101).fill(f.post(2))]) {
    f.setResponse(async () => result);await s.refresh();assert.deepEqual(s.snapshot().posts,good);assert.ok(s.snapshot().accounts[0].error);
  }
  assert.throws(() => s.postUrl({username:'thsottiaux',id:'javascript:alert(1)'}));
  assert.throws(() => s.markRead({username:'thsottiaux',id:f.post(9).id}));
});
test('translation is on demand, deduplicated and saved once across refresh and restart', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  assert.equal(f.translationCalls.length,0);const value = {username:'thsottiaux',id:f.post(1).id};let done;
  f.setTranslator(() => new Promise(resolve => {done = resolve;}));
  const task = s.translate({...value,text:'renderer cannot replace cached text'});
  assert.equal(s.translate(value),task);await turn();
  assert.equal(s.snapshot().posts[0].translating,true);assert.equal(f.translationCalls[0].text,f.post(1).text);
  done('保存的中文 <img src=x>');await task;
  assert.equal(s.snapshot().posts[0].translation.text,'保存的中文 <img src=x>');
  assert.equal(s.snapshot().posts[0].translating,false);assert.equal(s.summary().unread,1);
  await s.refresh();await s.translate(value);assert.equal(f.translationCalls.length,1);
  s.close();const restarted = f.create();await restarted.translate(value);
  assert.equal(restarted.snapshot().posts[0].translation.text,'保存的中文 <img src=x>');assert.equal(f.translationCalls.length,1);
});
test('changed source invalidates translation; truncated previews and fetched translations cannot replace saved content', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();const value = {username:'thsottiaux',id:f.post(1).id};
  await s.translate(value);const previous = s.snapshot().posts[0].translation;
  f.setResponse(async () => [{...f.post(1),text:'changed',translation:previous}]);await s.refresh();
  assert.equal(s.snapshot().posts[0].translation,undefined);await s.translate(value);
  assert.equal(s.snapshot().posts[0].translation.text,'中文：changed');
  f.setResponse(async () => [{...f.post(1),text:'changed',truncated:true}]);await s.refresh();
  assert.equal(s.snapshot().posts[0].translation.text,'中文：changed');assert.equal(s.snapshot().posts[0].truncated,false);
  assert.throws(() => s.translate({username:'thsottiaux',id:'javascript:alert(1)'}),/不存在/);
  assert.equal(f.translationCalls.length,2);
});
test('late translations cannot restore cleared, removed or changed posts, including remove and re-add', async t => {
  for (const action of ['clear','remove','change','close']) {
    const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();let done;
    f.setTranslator(() => new Promise(resolve => {done = resolve;}));
    const task = s.translate({username:'thsottiaux',id:f.post(1).id});await turn();
    if (action === 'clear') {s.clearCache();await s.refresh();}
    if (action === 'remove') {s.remove('thsottiaux');s.add('thsottiaux');await s.refresh();}
    if (action === 'change') {f.setResponse(async () => [{...f.post(1),text:'edited'}]);await s.refresh();}
    if (action === 'close') s.close();
    assert.equal(f.translationCalls[0].signal.aborted,true);done('late result');await task;
    assert.ok(s.snapshot().posts.every(p => !p.translation && !p.translating && !p.translationError));
  }
});
test('translations are independent from checks and read state, and concurrent requests are bounded', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();
  f.setResponse(async () => [1,2,3,4,5].map(i => f.post(i)));await s.refresh();
  const done = [];f.setTranslator(() => new Promise(resolve => done.push(resolve)));
  const tasks = [2,3,4].map(i => s.translate({username:'thsottiaux',id:f.post(i).id}));await turn();
  assert.equal(s.summary().busy,false);assert.throws(() => s.translate({username:'thsottiaux',id:f.post(5).id}),/最多同时/);
  s.markRead({username:'thsottiaux',id:f.post(2).id});s.setEnabled({username:'thsottiaux',enabled:false});await s.refresh();
  assert.ok(f.translationCalls.every(c => !c.signal.aborted));done.forEach(resolve => resolve('中文'));await Promise.all(tasks);
  assert.equal(s.snapshot().posts.filter(p => p.translation).length,3);assert.equal(s.snapshot().accounts[0].enabled,false);
  assert.equal(s.snapshot().posts.find(p => p.id === f.post(2).id).unread,false);
});
test('translation failure is retryable and sanitized; failed persistence never claims saved text', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();const value = {username:'thsottiaux',id:f.post(1).id};
  const file = path.join(f.dir,'message-subscriptions.json'), before = fs.readFileSync(file,'utf8');
  for (const response of [() => {throw Error('secret remote diagnostics');},() => '',() => 'x'.repeat(20001)]) {
    f.setTranslator(response);await s.translate(value);
    assert.match(s.snapshot().posts[0].translationError,/翻译失败/);assert.equal(s.snapshot().posts[0].translation,undefined);
    assert.ok(!JSON.stringify(s.snapshot()).includes('secret'));assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  fs.mkdirSync(file + '.tmp');f.setTranslator(async () => '保存失败的译文');await s.translate(value);
  assert.match(s.snapshot().storeError,/保存失败/);assert.equal(s.snapshot().posts[0].translation,undefined);
  assert.equal(fs.readFileSync(file,'utf8'),before);fs.rmdirSync(file + '.tmp');
  await s.translate(value);assert.equal(s.snapshot().posts[0].translation.text,'保存失败的译文');assert.equal(s.snapshot().posts[0].translationError,'');
});
test('invalid cached translations are discarded without losing source posts and read progress', async t => {
  const f = fixture(t), s = f.service;s.add('thsottiaux');await s.refresh();await s.translate({username:'thsottiaux',id:f.post(1).id});s.markRead(null);s.close();
  const file = path.join(f.dir,'message-subscriptions.json'), saved = JSON.parse(fs.readFileSync(file,'utf8'));
  saved.accounts[0].posts[0].text = 'modified on disk';fs.writeFileSync(file,JSON.stringify(saved));
  const restarted = f.create();assert.equal(restarted.snapshot().posts[0].translation,undefined);
  assert.equal(restarted.snapshot().posts[0].text,'modified on disk');assert.equal(restarted.snapshot().storeError,'');assert.equal(restarted.summary().unread,0);
});
test('avatars are cached once per account, survive restart and missing images without changing translation or read state',async t=>{
  const f=fixture(t),s=f.service,avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=';
  s.add('thsottiaux');f.setResponse(async()=>[{...f.post(1),avatar},{...f.post(2),avatar}]);await s.refresh();
  await s.translate({username:'thsottiaux',id:f.post(1).id});s.markRead(null);
  const file=path.join(f.dir,'message-subscriptions.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(saved.accounts[0].avatar,avatar);assert.ok(saved.accounts[0].posts.every(p=>!p.avatar));
  f.setResponse(async()=>[{...f.post(1),avatar:'data:image/svg+xml;base64,PHN2Zz4='}]);await s.refresh();s.close();
  const restarted=f.create();assert.equal(restarted.snapshot().accounts[0].avatar,avatar);assert.ok(restarted.snapshot().posts.every(p=>!p.avatar));assert.equal(restarted.summary().unread,0);assert.ok(restarted.snapshot().posts.find(p=>p.id===f.post(1).id).translation);
  restarted.close();saved.accounts[0].avatar='https://evil.test/image.png';fs.writeFileSync(file,JSON.stringify(saved));
  const invalid=f.create();assert.equal(invalid.snapshot().accounts[0].avatar,'');assert.equal(invalid.snapshot().storeError,'');
});


test('remarks persist through add, refresh, unfollow, cache clear and restart without changing account names',async t=>{
  const f=fixture(t),s=f.service;s.add({username:'@THSOTTIAUX',remark:'  AI 动态  '});
  assert.equal(s.snapshot().accounts[0].remark,'AI 动态');
  f.setResponse(async()=>[{...f.post(1),displayName:'Tibo'}]);await s.refresh();
  s.setRemark({username:'thsottiaux',remark:'<img src=x>'});s.setEnabled({username:'thsottiaux',enabled:false});
  assert.equal(s.snapshot().accounts[0].displayName,'Tibo');assert.equal(s.snapshot().accounts[0].remark,'<img src=x>');
  s.clearCache();s.close();const restarted=f.create();
  assert.equal(restarted.snapshot().accounts[0].remark,'<img src=x>');assert.equal(restarted.snapshot().accounts[0].enabled,false);
  restarted.setEnabled({username:'thsottiaux',enabled:true});restarted.setRemark({username:'thsottiaux',remark:''});
  assert.equal(restarted.snapshot().accounts[0].remark,'');
});
test('invalid remarks and failed saves preserve saved accounts and legacy accounts default to empty remarks',async t=>{
  const f=fixture(t),s=f.service;s.add('thsottiaux');assert.equal(s.snapshot().accounts[0].remark,'');
  const file=path.join(f.dir,'message-subscriptions.json'),original=fs.readFileSync(file,'utf8');
  for(const remark of [null,42,'x'.repeat(201),'first\nsecond']) {
    assert.throws(()=>s.setRemark({username:'thsottiaux',remark}),/备注/);
    assert.throws(()=>s.add({username:'openai',remark}),/备注/);
  }
  fs.mkdirSync(file+'.tmp');assert.throws(()=>s.setRemark({username:'thsottiaux',remark:'new'}),/保存失败/);
  assert.equal(s.snapshot().accounts[0].remark,'');assert.equal(fs.readFileSync(file,'utf8'),original);
  const saved=JSON.parse(original);delete saved.accounts[0].remark;fs.writeFileSync(file,JSON.stringify(saved));
  assert.equal(f.create().snapshot().accounts[0].remark,'');
});


test('recommendation reasons can be saved before following and survive refresh, removal, cache clear and restart',async t=>{
  const f=fixture(t),s=f.service;
  assert.deepEqual(s.snapshot().recommendationReasons,{});
  s.setRecommendationReason({username:'@THSOTTIAUX',reason:'  关注产品更新  '});
  assert.equal(s.snapshot().recommendationReasons.thsottiaux,'关注产品更新');
  assert.equal(s.snapshot().accounts.length,0);assert.equal(f.calls.length,0);
  s.add({username:'thsottiaux',remark:'独立备注'});await s.refresh();
  s.setEnabled({username:'thsottiaux',enabled:false});s.clearCache();s.remove('thsottiaux');s.close();
  const restarted=f.create();assert.equal(restarted.snapshot().recommendationReasons.thsottiaux,'关注产品更新');
  assert.equal(restarted.snapshot().accounts.length,0);
  restarted.setRecommendationReason({username:'thsottiaux',reason:''});restarted.close();
  assert.equal(f.create().snapshot().recommendationReasons.thsottiaux,'');
});
test('invalid reasons and failed persistence preserve the previous saved reason and do not create subscriptions',t=>{
  const f=fixture(t),s=f.service;s.setRecommendationReason({username:'thsottiaux',reason:'original'});
  const file=path.join(f.dir,'message-subscriptions.json'),original=fs.readFileSync(file,'utf8');
  for(const reason of [null,42,'x'.repeat(201),'line\nbreak']) assert.throws(()=>s.setRecommendationReason({username:'thsottiaux',reason}),/推荐理由/);
  fs.mkdirSync(file+'.tmp');assert.throws(()=>s.setRecommendationReason({username:'thsottiaux',reason:'new'}),/保存失败/);
  assert.equal(s.snapshot().recommendationReasons.thsottiaux,'original');assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal(s.snapshot().accounts.length,0);
});
