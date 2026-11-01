'use strict';
const fs = require('node:fs'), path = require('node:path');
const {createHash} = require('node:crypto');
const {displayName, xUsername, validPostId, compareIds, projectPost} = require('./x-posts.cjs');
const {avatarData} = require('./subscription-avatar.cjs');
const {TEXT_LIMIT} = require('./subscription-translation.cjs');
const INTERVAL = 60 * 60 * 1000, LIMIT = 100, ACCOUNT_LIMIT = 20, DELETED_LIMIT = 1000;
const stamp = value => value === null || Number.isSafeInteger(value) && value >= 0;
const sourceHash = post => createHash('sha256').update(JSON.stringify([post.text,post.truncated])).digest('hex');
const postKey = post => `${post.username}/${post.id}`;
function compactDeleted(account) {
  const ids = [...new Set(account.deletedIds)].filter(id => !account.deletedThroughId || compareIds(id,account.deletedThroughId) > 0)
    .sort((a,b) => compareIds(b,a));
  // 淘汰的旧 ID 合并为截止线，避免限制记录数量后又把删过的帖子抓回来。
  if (ids.length > DELETED_LIMIT) account.deletedThroughId = ids[DELETED_LIMIT];
  account.deletedIds = ids.slice(0,DELETED_LIMIT);
}
// 备注和推荐理由只接受短单行文本，避免异常输入写入本地配置。
function remarkText(value = '', label = '备注') {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw Error(`${label}须为 200 字以内的单行文字。`);
  return value.trim();
}
function cachedPost(item, username, now) {
  const post = projectPost(item,username,now), value = item.translation;
  // 旧缓存没有译文也能读取；不匹配当前正文的译文直接失效，不影响原文和阅读进度。
  if (value?.language === 'zh-CN' && value.provider === 'google' && value.sourceHash === sourceHash(post) &&
    typeof value.text === 'string' && value.text.trim() && value.text.length <= TEXT_LIMIT &&
    Number.isSafeInteger(value.translatedAt) && value.translatedAt >= 0) {
    post.translation = {text:value.text,language:'zh-CN',provider:'google',sourceHash:value.sourceHash,translatedAt:value.translatedAt};
  }
  return post;
}

function createMessageSubscriptions({dataDir, readPosts, translateText, onChange = () => {}, clock = {now:() => Date.now(), setTimeout, clearTimeout}}) {
  const file = path.join(dataDir, 'message-subscriptions.json');
  const translations = new Map(), translationErrors = new Map();
  let state = {version:2, accounts:[], recommendationReasons:{}}, storeError = '', retryAt = 0, blocked = false, timer, flight = null, controller, activeUsername = null, epoch = 0, closed = false, started = false, revision = 0;
  try {
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64000000) throw Error();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (![1,2].includes(saved.version) || !Array.isArray(saved.accounts) || saved.accounts.length > ACCOUNT_LIMIT) throw Error();
      // 理由独立于关注账号保存；未关注、取消关注或清缓存时仍可编辑和保留。
      const reasons = saved.recommendationReasons ?? {};
      if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons) || Object.keys(reasons).length > ACCOUNT_LIMIT) throw Error();
      state.recommendationReasons = Object.fromEntries(Object.entries(reasons).map(([username,reason])=>[xUsername(username),remarkText(reason,'推荐理由')]));
      const names = new Set();
      state.accounts = saved.accounts.map(a => {
        const username = xUsername(a.username);
        if (names.has(username) || typeof a.enabled !== 'boolean' || typeof a.initialized !== 'boolean' ||
          !stamp(a.attemptedAt) || !stamp(a.checkedAt) || (a.latestId !== null && !validPostId(a.latestId)) ||
          !Array.isArray(a.unreadIds) || a.unreadIds.length > LIMIT || !a.unreadIds.every(validPostId) ||
          !Array.isArray(a.posts) || a.posts.length > LIMIT ||
          (a.deletedIds !== undefined && (!Array.isArray(a.deletedIds) || !a.deletedIds.every(validPostId))) ||
          (a.deletedThroughId != null && !validPostId(a.deletedThroughId))) throw Error();
        names.add(username);
        // v1 无法区分默认已读和实际阅读，按本次约定一次性恢复现有缓存为未读。
        const account = {username, remark:typeof a.remark === 'string' ? remarkText(a.remark) : '', deletedIds:a.deletedIds || [], deletedThroughId:a.deletedThroughId ?? null, displayName:displayName(a.displayName), avatar:avatarData(a.avatar), enabled:a.enabled, initialized:a.initialized, latestId:a.latestId, unreadIds:[...new Set([...a.unreadIds,...(saved.version === 1 ? a.posts.map(p=>p.id) : [])])].sort((a,b)=>compareIds(b,a)).slice(0,LIMIT),
          attemptedAt:a.attemptedAt, checkedAt:a.checkedAt, error:typeof a.error === 'string' ? a.error.slice(0, 160) : '',
          posts:a.posts.map(item => cachedPost(item, username, clock.now()))};
        compactDeleted(account);return account;
      });
    }
  } catch {state = {version:2, accounts:[], recommendationReasons:{}};blocked = true;storeError = '消息订阅文件无法读取，原文件已保留，请检查本地文件后重启。';}
  const nextAt = a => a.attemptedAt === null ? clock.now() : Math.min(a.attemptedAt, clock.now()) + INTERVAL;
  function summary() {
    return {unread:state.accounts.reduce((sum,a) => sum + a.posts.filter(p => a.unreadIds.includes(p.id)).length, 0), busy:Boolean(flight), revision};
  }
  function snapshot() {
    const accounts = state.accounts.map(a => ({username:a.username, remark:a.remark || '', displayName:a.displayName || a.posts.find(p=>p.displayName)?.displayName || '', avatar:a.avatar || '', enabled:a.enabled, checkedAt:a.checkedAt, attemptedAt:a.attemptedAt,
      error:a.error, count:a.posts.length, unread:a.posts.filter(p => a.unreadIds.includes(p.id)).length,
      nextCheckAt:a.enabled ? nextAt(a) : null}));
    const posts = state.accounts.flatMap(a => a.posts.map(p => ({...p, unread:a.unreadIds.includes(p.id),
      translating:translations.has(postKey(p)), translationError:translationErrors.get(postKey(p))?.message || ''})))
      .sort((a,b) => compareIds(b.id,a.id));
    return {accounts, posts, recommendationReasons:{...state.recommendationReasons}, ...summary(), storeError, interval:INTERVAL, limit:LIMIT, accountLimit:ACCOUNT_LIMIT};
  }
  function commit(next) {
    if (blocked) throw Error(storeError);
    try {
      const json = JSON.stringify(next);
      // 和读取上限保持一致，不能保存一份下次启动无法读取的缓存。
      if (Buffer.byteLength(json) > 64000000) throw Error('cache limit');
      fs.writeFileSync(file + '.tmp', json, {mode:0o600});
      fs.renameSync(file + '.tmp', file);
    } catch {storeError = '消息订阅保存失败，已有文件和内容已保留，请重试。';retryAt = clock.now() + INTERVAL;revision++;onChange();throw Error(storeError);}
    state = next;pruneTranslations();storeError = '';retryAt = 0;revision++;onChange();
  }
  function pruneTranslations() {
    const sources = new Map(state.accounts.flatMap(a => a.posts.map(p => [postKey(p),sourceHash(p)])));
    // 清缓存、删除、淘汰或原文变化后取消对应任务；仅比较 ID 会把旧译文写回新正文。
    for (const [key,task] of translations) if (sources.get(key) !== task.hash) {translations.delete(key);task.controller.abort();}
    for (const [key,value] of translationErrors) if (sources.get(key) !== value.hash) translationErrors.delete(key);
  }
  function schedule() {
    clock.clearTimeout(timer);timer = null;
    const enabled = state.accounts.filter(a => a.enabled);
    if (closed || !started || blocked || flight || !enabled.length) return;
    const at = Math.max(retryAt, Math.min(...enabled.map(nextAt)));
    timer = clock.setTimeout(() => {timer = null;void refresh(false);}, Math.max(0, at - clock.now()));timer.unref?.();
  }
  // 配置、清理和暂停会使旧批次失效；迟到的网页结果不能重新写回被清空或删除的内容。
  function invalidate() {epoch++;controller?.abort();clock.clearTimeout(timer);timer = null;}
  function mutate(fn, invalidateBatch = false) {
    if (closed) throw Error('消息订阅已停止。');
    const next = structuredClone(state);fn(next);commit(next);
    if (invalidateBatch) invalidate();
    schedule();return snapshot();
  }
  function refresh(force = true) {
    if (closed || blocked) return Promise.resolve(snapshot());
    if (flight) return flight;
    const names = state.accounts.filter(a => a.enabled && (force || nextAt(a) <= clock.now())).map(a => a.username);
    if (!names.length) {schedule();return Promise.resolve(snapshot());}
    clock.clearTimeout(timer);timer = null;const batch = epoch;
    flight = Promise.resolve().then(async () => {
      for (const username of names) {
        if (closed || epoch !== batch) break;
        let a = state.accounts.find(item => item.username === username);
        if (!a?.enabled) continue;
        const attempted = structuredClone(state);attempted.accounts.find(item => item.username === username).attemptedAt = clock.now();
        try {commit(attempted);} catch {break;}
        controller = new AbortController();activeUsername = username;
        try {
          const result = await readPosts(username, {signal:controller.signal});
          if (closed || epoch !== batch) break;
          if (!Array.isArray(result) || result.length > LIMIT) throw Error('invalid response');
          const next = structuredClone(state);a = next.accounts.find(item => item.username === username);
          // 按最新删除记录及截止线过滤；已有旧缓存可更新，未缓存的截止线之前帖子不再回填。
          const deleted = new Set(a.deletedIds), retained = new Set(a.posts.map(post=>post.id));
          const incoming = result.map(item => projectPost(item, username, clock.now())).filter(post=>!deleted.has(post.id) &&
            (!a.deletedThroughId || compareIds(post.id,a.deletedThroughId) > 0 || retained.has(post.id)));
          // 头像按账号只存一份；抓取失败保留已有图片，避免每条动态重复占用缓存。
          a.avatar = result.map(item=>avatarData(item.avatar)).find(Boolean) || a.avatar || '';
          // 昵称属于账号资料，独立于正文缓存保存；偶尔读取不到时保留已有昵称。
          a.displayName = incoming.find(p=>p.displayName)?.displayName || a.displayName || '';
          const unread = new Set(a.unreadIds);
          // 首次抓取也应显示未读；已读后仍用递增 ID 游标去重，清缓存不重置阅读进度。
          for (const post of incoming) if (a.latestId === null || compareIds(post.id,a.latestId) > 0) unread.add(post.id);
          for (const post of incoming) if (a.latestId === null || compareIds(post.id,a.latestId) > 0) a.latestId = post.id;
          a.unreadIds = [...unread].sort((a,b) => compareIds(b,a)).slice(0,LIMIT);
          const merged = new Map(a.posts.map(p => [p.id,p]));
          for (const post of incoming) {
            const previous = merged.get(post.id);
            post.displayName ||= previous?.displayName || a.displayName;
            // 已有全文不被偶尔抓到的主页摘要降级，避免丢失正文及其译文。
            if (previous && !previous.truncated && post.truncated) continue;
            // 同一条原文未变时保留本地译文；采集结果不能自行提供或覆盖译文。
            if (previous?.translation && sourceHash(previous) === sourceHash(post)) post.translation = previous.translation;
            merged.set(post.id,post);
          }
          a.posts = [...merged.values()].sort((a,b) => compareIds(b.id,a.id)).slice(0,LIMIT);
          a.initialized = true;a.checkedAt = clock.now();a.error = '';commit(next);
        } catch (error) {
          if (closed || epoch !== batch) break;
          const next = structuredClone(state);a = next.accounts.find(item => item.username === username);
          a.error = error.code === 'X_PUBLIC_UNAVAILABLE' ? '公开页面暂未提供可读取的动态，可能需要登录；请打开主页确认。' : '动态读取失败，已保留上次内容，将在一小时后重试。';
          try {commit(next);} catch {break;}
        } finally {controller = null;activeUsername = null;}
      }
    }).finally(() => {flight = null;schedule();onChange();}).then(snapshot);
    onChange();return flight;
  }
  function account(next, value) {
    const name = xUsername(value), found = next.accounts.find(a => a.username === name);
    if (!found) throw Error('订阅账号不存在。');return found;
  }
  function add(value) {
    const username = xUsername(typeof value === 'string' ? value : value?.username);
    const remark = remarkText(typeof value === 'string' ? '' : value?.remark);
    return mutate(next => {
      if (next.accounts.some(a => a.username === username)) throw Error('这个账号已在订阅列表中。');
      if (next.accounts.length >= ACCOUNT_LIMIT) throw Error(`最多订阅 ${ACCOUNT_LIMIT} 个账号。`);
      next.accounts.push({username, remark, enabled:true, initialized:false, latestId:null, unreadIds:[], deletedIds:[], deletedThroughId:null, posts:[], checkedAt:null, attemptedAt:null, error:''});
    });
  }
  function setRecommendationReason(value) {
    const username = xUsername(value?.username), reason = remarkText(value?.reason,'推荐理由');
    // 走同一原子写入流程，落盘失败时保留旧值；不添加账号、不触发采集。
    return mutate(next => {
      if (!Object.hasOwn(next.recommendationReasons,username) && Object.keys(next.recommendationReasons).length >= ACCOUNT_LIMIT) throw Error('推荐理由数量已达上限。');
      next.recommendationReasons = {...next.recommendationReasons,[username]:reason};
    });
  }
  // 用户备注属于本地配置，采集得到的昵称和正文不会覆盖它。
  function setRemark(value) {
    const remark = remarkText(value?.remark);
    return mutate(next => {account(next,value?.username).remark = remark;});
  }
  function setEnabled(value) {
    if (typeof value?.enabled !== 'boolean') throw Error('无效的订阅开关。');
    const username = xUsername(value.username);
    // 只中止当前被暂停的账号；操作队列中其他账号时，正在读取的账号继续完成。
    return mutate(next => {account(next,username).enabled = value.enabled;},!value.enabled && activeUsername === username);
  }
  function remove(value) {
    const username = xUsername(value);
    return mutate(next => {const a = account(next,username);next.accounts = next.accounts.filter(item => item !== a);},activeUsername === username);
  }
  function clearCache() {return mutate(next => {for (const a of next.accounts) a.posts = [];},true);}
  function markRead(value) {
    return mutate(next => {
      if (value === null) {for (const a of next.accounts) a.unreadIds = [];return;}
      const a = account(next,value?.username);
      if (!validPostId(value?.id) || !a.posts.some(p => p.id === value.id)) throw Error('动态不存在。');
      a.unreadIds = a.unreadIds.filter(id => id !== value.id);
    });
  }
  function deletePost(value) {
    return mutate(next => {
      const a = account(next,value?.username);
      if (!validPostId(value?.id) || !a.posts.some(p=>p.id === value.id)) throw Error('动态不存在。');
      // 从持久化缓存中移除整条正文及译文，同时清理未读；commit 会中止该条翻译。
      a.posts = a.posts.filter(p=>p.id !== value.id);
      a.unreadIds = a.unreadIds.filter(id=>id !== value.id);
      a.deletedIds = [...new Set([...a.deletedIds,value.id])];
      compactDeleted(a);
    });
  }
  function postUrl(value) {
    const a = account(state,value?.username), post = a.posts.find(p => p.id === value?.id);
    if (!post) throw Error('动态不存在。');return `https://x.com/${a.username}/status/${post.id}`;
  }
  function translate(value) {
    if (closed || blocked) return Promise.reject(Error(storeError || '消息订阅已停止。'));
    const a = account(state,value?.username), post = a.posts.find(p => p.id === value?.id);
    if (!post) throw Error('动态不存在。');
    if (post.translation) return Promise.resolve(snapshot());
    const key = postKey(post), existing = translations.get(key);
    if (existing) return existing.promise;
    if (translations.size >= 3) throw Error('最多同时翻译 3 条动态，请稍后再试。');
    if (typeof translateText !== 'function') throw Error('在线翻译尚未就绪。');
    const task = {hash:sourceHash(post),controller:new AbortController(),promise:null};
    const current = () => !closed && translations.get(key) === task && !task.controller.signal.aborted;
    translations.set(key,task);translationErrors.delete(key);revision++;
    // 每条动态独立去重，不占用订阅刷新锁；完成时读取最新状态，保留期间的已读/账号操作。
    task.promise = Promise.resolve().then(async () => {
      try {
        const text = await translateText(post.text,{signal:task.controller.signal});
        if (!current()) return;
        if (typeof text !== 'string' || !text.trim() || text.length > TEXT_LIMIT) throw Error('invalid translation');
        const next = structuredClone(state), target = account(next,a.username).posts.find(p => p.id === post.id);
        target.translation = {text,language:'zh-CN',provider:'google',sourceHash:task.hash,translatedAt:clock.now()};
        commit(next);
      } catch {
        if (current()) translationErrors.set(key,{hash:task.hash,message:storeError || '翻译失败，原文已保留，请重试。'});
      } finally {
        if (translations.get(key) === task) {translations.delete(key);revision++;onChange();}
      }
    }).then(snapshot);
    onChange();return task.promise;
  }
  return {snapshot, summary, add, setRecommendationReason, setRemark, setEnabled, remove, clearCache, markRead, deletePost, refresh, postUrl, translate,
    start() {if (closed || started) return;started = true;void refresh(false);},
    checkDue:() => refresh(false),
    close() {closed = true;invalidate();for (const task of translations.values()) task.controller.abort();translations.clear();translationErrors.clear();}};
}
module.exports = {createMessageSubscriptions, INTERVAL};
