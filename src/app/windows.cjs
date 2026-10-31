'use strict';
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const {createPetMenu}=require('./pet-menu.cjs');
const {createPetRanking}=require('./pet-ranking.cjs');
const {createPetStorage}=require('./pet-storage.cjs');

// 此模块只负责 Electron 窗口、菜单和拖动；任务状态和交互规则由应用层传入。
function createWindows({ snapshot, performAction, collapseReminders, rankingSnapshot, rankingRefresh, rankingSelect }) {
  let panel, pet, tray, accountPanel, accountLoading, accountData, accountResolve, accountSequence = 0, quitting = false;
  let dragOrigin=null,petInteractive=false,ignoredMouse;
  const fromPet=event=>Boolean(pet&&!pet.isDestroyed()&&event.sender===pet.webContents&&event.senderFrame===pet.webContents.mainFrame);
  function updatePetMouse() {
    if(!pet||pet.isDestroyed())return;
    const ignore=!petInteractive&&!dragOrigin;
    if(ignore===ignoredMouse)return;
    ignoredMouse=ignore;
    // 保留移动事件，鼠标重新进入人物或气泡时才能恢复点击。
    pet.setIgnoreMouseEvents(ignore,{forward:true});
  }
  function pointerChanged(){if(pet&&!pet.isDestroyed())pet.webContents.send('pet-pointer-changed');}
  const preferences = () => ({ preload:path.join(__dirname, '../ui/preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true });
  function protect(win) {
    // 页面不接收任意导航，也不能借链接打开具有 Node 权限的新窗口。
    win.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
  }
  const petStorage=createPetStorage({getPet:()=>pet,protect,onRestore:()=>resizePet(snapshot()),onChange:updateTrayMenu,
    closeOverlays:()=>{closeAccountMenu();petMenu.close();petRanking.close();},onContextMenu:()=>petMenu.open(),onHide:hidePet});
  const petMenu=createPetMenu({getPet:()=>petStorage.activeWindow(),snapshot:()=>({...snapshot(),petStored:petStorage.isStored()}),performAction,showPanel,restartApp,protect,hidePet});
  const petRanking=createPetRanking({getPet:()=>pet,snapshot:rankingSnapshot,refresh:rankingRefresh,select:rankingSelect,protect});
  function createPanel() {
    panel = new BrowserWindow({ width:1060, height:770, minWidth:860, minHeight:680, title:'', backgroundColor:'#f5f7f4', webPreferences:preferences() });
    panel.on('page-title-updated', event => { event.preventDefault(); panel.setTitle(''); });
    protect(panel);
    panel.loadFile(path.join(__dirname, '../ui/index.html'));
    panel.on('close', event => { if (!quitting) { event.preventDefault(); panel.hide(); } });
  }
  function showPanel() {
    if (!panel || panel.isDestroyed()) createPanel();
    else { panel.show(); panel.focus(); }
  }
  function showReminders() {
    showPanel();
    const reveal = () => panel.webContents.send('show-reminders');
    if (panel.webContents.isLoadingMainFrame()) panel.webContents.once('did-finish-load', reveal);
    else reveal();
  }
  function showPlanner() {
    showPanel();
    const reveal=()=>panel.webContents.send('show-planner');
    if(panel.webContents.isLoadingMainFrame())panel.webContents.once('did-finish-load',reveal);else reveal();
  }
  function showSubscriptions() {
    showPanel();
    const reveal=()=>panel.webContents.send('show-subscriptions');
    if(panel.webContents.isLoadingMainFrame())panel.webContents.once('did-finish-load',reveal);else reveal();
  }
  function restartApp() { app.relaunch(); app.quit(); }
  function closeAccountMenu(accountId = null) {
    accountSequence++;
    const resolve = accountResolve;accountResolve = null;
    if (accountPanel && !accountPanel.isDestroyed()) accountPanel.hide();
    resolve?.(accountId);
  }
  async function chooseTrackingAccount(accounts, accountId) {
    if (accounts.length <= 1) return null;
    if (!pet || pet.isDestroyed() || !pet.isVisible() || accountResolve) return null;
    petMenu.close();petRanking.close();
    const request = ++accountSequence;
    const art = await pet.webContents.executeJavaScript(`(() => {const r=document.getElementById('pet-art').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};})()`);
    if (request !== accountSequence || pet.isDestroyed() || !pet.isVisible()) return null;
    if (!accountPanel || accountPanel.isDestroyed()) {
      accountPanel = new BrowserWindow({width:300, height:320, show:false, transparent:true, frame:false, resizable:false,
        hasShadow:false, alwaysOnTop:true, skipTaskbar:true,
        webPreferences:{preload:path.join(__dirname, '../ui/pet-accounts-preload.cjs'), contextIsolation:true, nodeIntegration:false, sandbox:true}});
      protect(accountPanel);accountPanel.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen:true});
      accountPanel.on('blur', () => closeAccountMenu());
      accountPanel.on('closed', () => closeAccountMenu());
      accountLoading = accountPanel.loadFile(path.join(__dirname, '../ui/pet-accounts.html'));
    }
    await accountLoading;
    if (request !== accountSequence || pet.isDestroyed() || !pet.isVisible()) return null;
    accountData = {accountId, accounts:accounts.map(account => ({id:account.id, name:account.name,
      remaining:account.sevenDayWindowMinutes !== 0 ? account.sevenDayRemaining : null, paused:account.refreshEnabled === false}))};
    const bounds = pet.getContentBounds(), area = screen.getDisplayMatching(pet.getBounds()).workArea;
    const width = Math.min(300, area.width), height = Math.min(84 + accounts.length * 49, 340, area.height);
    const left = bounds.x + art.left - width - 8;
    const x = Math.max(area.x, Math.min(area.x + area.width - width, left >= area.x ? left : bounds.x + art.right + 8));
    const y = Math.max(area.y, Math.min(area.y + area.height - height, bounds.y + art.bottom - height));
    accountPanel.setBounds({x:Math.round(x), y:Math.round(y), width, height});
    return new Promise(resolve => {
      accountResolve = resolve;
      accountPanel.webContents.send('pet-accounts-open');
      accountPanel.show();accountPanel.focus();
    });
  }
  const fromAccounts = event => Boolean(accountResolve && accountPanel && !accountPanel.isDestroyed() &&
    event.sender === accountPanel.webContents && event.senderFrame === accountPanel.webContents.mainFrame);
  ipcMain.handle('pet-accounts-data', event => {
    if (!fromAccounts(event)) throw Error('仅允许在账号选择窗口读取列表');
    return accountData;
  });
  ipcMain.on('pet-accounts-select', (event, id) => {
    if (fromAccounts(event) && accountData.accounts.some(account => account.id === id)) closeAccountMenu(id);
  });
  ipcMain.on('pet-accounts-close', event => {if (fromAccounts(event)) closeAccountMenu();});
  function updateTrayMenu() {
    if (!tray || tray.isDestroyed() || !pet || pet.isDestroyed()) return;
    const visible = pet.isVisible()||petStorage.isVisible();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label:'打开小屋', click:showPanel },
      ...(visible?[{label:petStorage.isStored()?'恢复桌宠':'收纳到边缘',click:()=>petStorage.isStored()?petStorage.restore():void petStorage.store().catch(()=>{})}]:[]),
      { label:visible ? '隐藏桌宠' : '显示桌宠', click:() => visible ? hidePet() : petStorage.restore() },
      { type:'separator' },
      { label:'重启', click:restartApp },
      { label:'退出', click:() => app.quit() }
    ]));
  }
  function createPet() {
    const area = screen.getPrimaryDisplay().workArea;
    // macOS 无边框窗口还需关闭原生屏幕约束，否则向上移动仍会停在菜单栏下方。
    pet = new BrowserWindow({ width:220, height:320, x:area.x + area.width - 240, y:area.y + area.height - 340,
      // 与收纳标记一致，使用非激活面板；还原后接收点击也不能激活应用、带出后台小屋。
      type:'panel',transparent:true, frame:false, resizable:false, enableLargerThanScreen:true, hasShadow:false, alwaysOnTop:true, skipTaskbar:true, webPreferences:preferences() });
    protect(pet);
    updatePetMouse();
    pet.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen:true });
    pet.loadFile(path.join(__dirname, '../ui/pet.html'));
    pet.on('show', () => {pointerChanged();updateTrayMenu();});
    pet.on('hide', () => {dragOrigin=null;updatePetMouse();closeAccountMenu();petMenu.close();petRanking.close();updateTrayMenu();});
    // 焦点进入桌宠弹窗时不折叠提醒，避免人物几何在弹出过程中变化。
    pet.on('blur', () => {dragOrigin=null;updatePetMouse();pointerChanged();if(!accountResolve&&!petMenu.isOpen()&&!petRanking.isOpen())collapseReminders();});
    pet.on('move',()=>{closeAccountMenu();petMenu.close();petRanking.close();pointerChanged();});
    pet.on('resize',()=>{closeAccountMenu();petMenu.close();petRanking.close();pointerChanged();});
    pet.webContents.on('context-menu',petMenu.open);
    pet.on('close', event => { if (!quitting) { event.preventDefault(); pet.hide(); } });
  }
  function resizePet(data) {
    if (!pet || pet.isDestroyed() || petStorage.isStored()) return;
    const bounds = pet.getBounds();
    // 分类及展开规则与提醒视图一致，避免自动展示的列表被收起尺寸的窗口裁切。
    const view = data.reminderView || (data.busyExpanded ? 'busy' : data.activity.pending ? 'pending' : data.activity.unread ? 'completed' : data.activity.working ? 'busy' : 'completed');
    const count = view === 'pending' ? data.activity.pending : view === 'busy' ? data.activity.working : data.activity.unread;
    const expanded = (view === 'pending' ? data.pendingExpanded : view === 'busy' ? data.busyExpanded : data.completionExpanded) || (count > 0 && count <= (data.shortcuts?.reminderCollapseThreshold ?? 3));
    const plannerActive=Boolean(data.planner?.active.length);
    const width = data.state === 'fireworks' ? 340 : expanded||plannerActive ? 260 : 220;
    const height = (expanded ? (count === 1 ? 380 : 440) : 320) + (plannerActive?144:0) + Math.max(0, Math.min(data.trackingRows || 0, 5) - 1) * 33;
    if (bounds.width === width && bounds.height === height) return;
    // 提醒向上展开，烟花横向留白；只保持人物中心与脚底，不把用户选择的位置拉回屏幕内。
    const x = Math.round(bounds.x + (bounds.width - width) / 2);
    const y = bounds.y + bounds.height - height;
    pet.setBounds({ ...bounds, x, y, width, height });
  }

  // 只接受悬浮窗发起的拖动；按屏幕坐标差自由移动，允许气泡或人物部分移出屏幕。
  ipcMain.on('pet-interactive',(event,value)=>{
    if(!fromPet(event)||typeof value!=='boolean')return;
    petInteractive=value;updatePetMouse();
  });
  ipcMain.handle('pet-pointer',event=>{
    if(!fromPet(event)||!pet.isVisible())return null;
    const point=screen.getCursorScreenPoint(),bounds=pet.getContentBounds();
    return {x:point.x-bounds.x,y:point.y-bounds.y};
  });
  ipcMain.on('pet-drag', (event, phase, point) => {
    if (!fromPet(event)) return;
    if (phase === 'end') { dragOrigin = null;updatePetMouse(); return; }
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    // 以按下时的鼠标与窗口位置为基准，避免窗口移动后重复叠加位移造成跳动。
    if (phase === 'start') {dragOrigin = { mouse:point, bounds:pet.getBounds() };updatePetMouse();}
    else if (phase === 'move' && dragOrigin) {
      const x = Math.round(dragOrigin.bounds.x + point.x - dragOrigin.mouse.x);
      const y = Math.round(dragOrigin.bounds.y + point.y - dragOrigin.mouse.y);
      pet.setPosition(x,y);
    }
  });
  app.on('second-instance', showPanel);
  // 忽略窗口初始化前的启动激活事件；启动后点击 Dock 仍可主动打开小屋。
  app.on('activate', () => {if (pet && !pet.isDestroyed()) showPanel();});
  function hidePet(){petStorage.hide();pet?.hide();updateTrayMenu();}
  app.on('before-quit', () => { quitting = true;petStorage.stop();closeAccountMenu();petMenu.close();petRanking.close(); });

  return {
    showPanel, showReminders, showPlanner, showSubscriptions, chooseTrackingAccount,
    isPetVisible:()=>Boolean(pet&&!pet.isDestroyed()&&(pet.isVisible()||petStorage.isVisible())),
    isPanel:sender=>sender===panel?.webContents,
    isPet:sender=>sender===pet?.webContents,
    toggleRanking:id=>{petMenu.close();return petRanking.toggle(id);},
    closeQuotaOverlays:()=>{closeAccountMenu();petRanking.close();},
    start({showPanelOnStartup = true} = {}) {
      if (showPanelOnStartup) createPanel();
      createPet();
      const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png')).resize({ width:20, height:20 });
      tray = new Tray(icon);
      tray.setToolTip('鲸鱼娘');
      updateTrayMenu();
      tray.on('click', showPanel);
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label:'鲸鱼娘', submenu:[{ role:'about' }, { type:'separator' }, { role:'quit' }] }, { role:'editMenu' }, { role:'windowMenu' }]));
    },
    broadcast(data) {
      resizePet(data);
      petStorage.refresh(data);
      petMenu.refresh();
      for (const win of [panel, pet]) if (win && !win.isDestroyed()) win.webContents.send('snapshot', data);
    },
    chime() { pet.webContents.send('chime'); },
    storePet:()=>petStorage.store(),
    showPet:()=>petStorage.restore(),
    hidePet
  };
}

module.exports = { createWindows };
