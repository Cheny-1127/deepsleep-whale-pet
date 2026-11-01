'use strict';
const {BrowserWindow, ipcMain, screen} = require('electron');
const path = require('node:path');

// 榜单使用独立小窗，避免改变人物几何和透明区域的点击穿透。
function createPetRanking({getPet, snapshot, refresh, select, protect}) {
  let panel, loading, placement, sequence = 0, active = false, trackingId = 'primary';
  // 关闭或切换来源时废弃旧请求，避免异步读取坐标后又弹出上一条账号的榜单。
  function close() {sequence++;active = false;if (panel && !panel.isDestroyed()) panel.hide();}
  async function toggle(id = 'primary') {
    if (active && id === trackingId) {close();return;}
    close();trackingId = id;
    const pet = getPet(), request = ++sequence;
    if (!pet || pet.isDestroyed() || !pet.isVisible()) return;
    let anchor;
    const elementId = id === 'primary' ? 'pet-quota-controls' : `pet-quota-config-${id}`;
    // 以本次点击的额度条定位，副配置不能继续共用人物坐标；读取实际位置兼容滚动。
    try {anchor = await pet.webContents.executeJavaScript(`(() => {const bar=document.getElementById(${JSON.stringify(elementId)});if(!bar||bar.hidden)return null;const r=bar.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()`);} catch {return;}
    if (request !== sequence || !anchor || !['left', 'right', 'top', 'bottom'].every(key => Number.isFinite(anchor[key]))) return;
    if (!panel || panel.isDestroyed()) {
      panel = new BrowserWindow({width:306, height:320, show:false, transparent:true, frame:false, resizable:false,
        type:'panel', hasShadow:false, alwaysOnTop:true, skipTaskbar:true,
        webPreferences:{preload:path.join(__dirname, '../ui/pet-ranking-preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true}});
      protect(panel);panel.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true});
      panel.on('blur', close);
      loading = panel.loadFile(path.join(__dirname, '../ui/pet-ranking.html'));
    }
    try {await loading;} catch {return;}
    if (request !== sequence || pet.isDestroyed() || !pet.isVisible()) return;
    const bounds = pet.getContentBounds(), area = screen.getDisplayMatching(pet.getBounds()).workArea;
    const width = Math.min(306, area.width), height = Math.min(320, area.height), left = bounds.x + anchor.left - width - 8;
    // 优先放在该条左侧，靠左边缘时翻到右侧；内容高度变化时仍对齐同一条底边。
    const x = Math.max(area.x, Math.min(area.x + area.width - width, left >= area.x ? left : bounds.x + anchor.right + 8));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, bounds.y + anchor.bottom - height));
    placement = {area, bottom:bounds.y + anchor.bottom};
    panel.setBounds({x:Math.round(x), y:Math.round(y), width, height});
    active = true;panel.webContents.send?.('pet-ranking-open');panel.show();panel.focus();
  }
  // 仅榜单自身的主 frame 可读取、刷新或改分组，其他窗口不能借用当前来源。
  const ownFrame = event => panel && !panel.isDestroyed() && event.sender === panel.webContents && event.senderFrame === panel.webContents.mainFrame;
  ipcMain.handle('pet-ranking-data', event => {
    if (!ownFrame(event)) throw Error('仅允许在榜单窗口读取排行');
    return snapshot(trackingId);
  });
  ipcMain.handle('pet-ranking-refresh', event => {
    if (!ownFrame(event)) throw Error('仅允许在榜单窗口刷新排行');
    return refresh(trackingId);
  });
  ipcMain.handle('pet-ranking-select', (event, groupId) => {
    if (!ownFrame(event)) throw Error('仅允许在榜单窗口切换分组');
    return select(groupId,trackingId);
  });
  ipcMain.on('pet-ranking-close', event => {if (ownFrame(event)) close();});
  ipcMain.on('pet-ranking-size', (event, requested) => {
    if (!ownFrame(event) || !active || !Number.isInteger(requested) || requested < 60 || requested > 400) return;
    // 展开分组菜单会改变内容高度，始终沿用打开时的账号条锚点并约束在当前屏幕。
    const {area, bottom} = placement, bounds = panel.getBounds(), height = Math.min(requested, area.height);
    const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, bottom - height)));
    if (height !== bounds.height || y !== bounds.y) panel.setBounds({...bounds, y, height});
  });
  return {toggle, close, isOpen:() => active};
}
module.exports = {createPetRanking};
