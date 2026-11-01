'use strict';
// macOS 焦点回归：仅显示两个独立测试实例，不启动业务服务或操作日常桌宠。
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const createPetMenuDriver=require('./pet-menu-driver.cjs');
async function main() {
  if(process.platform!=='darwin'){console.log('Pet menu focus: macOS only');return;}
  const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-menu-focus-')),apps=[],errors=[];
  fs.writeFileSync(path.join(dir,'pet.html'),'<div id="pet-art" style="width:180px;height:220px;background:#dbe8e0">测试桌宠</div><div id="pet-quota-controls">测试额度</div><button id="pet-store-button">收纳</button><script>document.getElementById("pet-store-button").onclick=()=>window.whale.action("store-pet");</script>');
  fs.writeFileSync(path.join(dir,'index.html'),'<p>测试小屋</p>');
  fs.writeFileSync(path.join(dir,'cover.html'),'<p>模拟遮挡小屋的其他应用</p>');
  fs.writeFileSync(path.join(dir,'bootstrap.cjs'),`
    const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');
    app.setPath('userData',path.join(__dirname,process.env.WHALE_FOCUS_ROLE));
    app.setActivationPolicy('accessory');
    global.fixture={active:false,activations:0,panelFocus:0,panelOpens:0,events:[]};
    app.on('browser-window-created',(_event,win)=>{
      for(const type of ['show','hide','focus','blur'])win.on(type,()=>fixture.events.push({type,id:win.id,open:fixture.menu?.isOpen()}));
    });
    app.on('did-become-active',()=>{fixture.active=true;fixture.activations++;});
    app.on('did-resign-active',()=>{fixture.active=false;});
    app.whenReady().then(async()=>{
      const options={show:false,focusable:false,alwaysOnTop:false,skipTaskbar:true};
      if(process.env.WHALE_FOCUS_ROLE==='cover') {
        fixture.cover=new BrowserWindow({...options,width:1100,height:800});
        await fixture.cover.loadFile(path.join(__dirname,'cover.html'));return;
      }
      // 使用正式窗口层的原生窗口选项，仅将页面换成本地合成内容，避免替身漏掉人物激活行为。
      const loadFile=BrowserWindow.prototype.loadFile;
      BrowserWindow.prototype.loadFile=function(file,...args){
        const name=path.basename(file);
        if(name==='pet-accounts.html')fixture.accountsWindow=this;
        return loadFile.call(this,['index.html','pet.html'].includes(name)?path.join(__dirname,name):file,...args);
      };
      const menuModule=require(${JSON.stringify(path.join(root,'src/app/pet-menu.cjs'))}),makeMenu=menuModule.createPetMenu;
      menuModule.createPetMenu=options=>fixture.menu=makeMenu({...options,showPanel(){fixture.panelOpens++;options.showPanel();}});
      const storageModule=require(${JSON.stringify(path.join(root,'src/app/pet-storage.cjs'))}),makeStorage=storageModule.createPetStorage;
      storageModule.createPetStorage=options=>fixture.storage=makeStorage(options);
      const {createWindows}=require(${JSON.stringify(path.join(root,'src/app/windows.cjs'))});
      const snapshot=()=>({state:'idle',activity:{state:'idle',pending:0,working:0,unread:0},planner:{active:[]}});
      const performAction=name=>name==='store-pet'?fixture.windows.storePet():fixture.windows.showPet();
      const rankingSnapshot=()=>({users:[],groups:[],groupId:null,groupName:'全部分组',checkedAt:null,busy:false,error:'',source:{configName:'测试配置',accountName:'测试账号'}});
      fixture.windows=createWindows({snapshot,performAction,collapseReminders(){},rankingSnapshot,rankingRefresh:rankingSnapshot,rankingSelect:rankingSnapshot});
      ipcMain.handle('action',(_event,name)=>performAction(name));
      fixture.windows.start({showPanelOnStartup:true});
      fixture.panel=BrowserWindow.getAllWindows().find(win=>win.getBounds().width===1060);
      fixture.pet=BrowserWindow.getAllWindows().find(win=>win.getBounds().width===220);
      fixture.panel.on('focus',()=>fixture.panelFocus++);
    });
  `);
  async function launch(role) {
    const app=await electron.launch({executablePath:require('electron'),args:[path.join(dir,'bootstrap.cjs')],
      env:{...process.env,WHALE_FOCUS_ROLE:role,WHALE_DATA_DIR:path.join(dir,role)},timeout:10000});
    apps.push(app);app.on('window',page=>page.on('pageerror',error=>errors.push(error.message)));return app;
  }
  async function waitFor(app,predicate) {
    await app.evaluate(async(_electron,source)=>{
      for(let i=0;i<100;i++) {
        if(new Function('return ('+source+')(global.fixture)')())return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      throw Error('焦点状态等待超时：'+source);
    },String(predicate));
  }
  try {
    const target=await launch('target');await target.firstWindow();
    await waitFor(target,f=>f.pet&&f.panel&&!f.pet.webContents.isLoadingMainFrame());
    const pet=target.windows().find(page=>page.url().endsWith('/pet.html'));
    // 保持正式桌宠的悬浮层级，避免遮挡应用覆盖桌宠后额外触发 hide 事件。
    await target.evaluate(()=>{fixture.panel.setFocusable(true);fixture.panel.show();fixture.pet.setAlwaysOnTop(true);fixture.pet.showInactive();});
    const cover=await launch('cover');await cover.firstWindow();
    async function coverPanel() {
      await cover.evaluate(()=>{fixture.cover.setFocusable(true);fixture.cover.show();fixture.cover.focus();});
      await waitFor(cover,f=>f.active);
      await waitFor(target,f=>!f.active);
    }
    const driver=createPetMenuDriver(target,pet);
    await coverPanel();
    const before=await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus}));
    const menu=await driver.open();
    await target.evaluate(({BrowserWindow})=>{fixture.menuWindow=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet-menu.html'));});
    // 等原生焦点就绪后再采样；菜单获得键盘焦点不应增加整个应用的激活次数。
    await waitFor(target,f=>f.menuWindow.isFocused());
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before,
      '打开右键菜单不能激活整个应用或把后台小屋带到前台');
    assert.equal(await cover.evaluate(()=>fixture.active),true);
    await menu.keyboard.press('ArrowDown');await menu.keyboard.press('ArrowDown');await menu.keyboard.press('ArrowDown');await menu.keyboard.press('ArrowDown');
    assert.equal(await menu.evaluate(()=>document.activeElement.dataset.id),'hide','非激活菜单仍接受键盘操作');
    await menu.keyboard.press('Enter');
    await waitFor(target,f=>!f.pet.isVisible()&&!f.menu.isOpen());
    assert.equal((await driver.geometry()).visible,false);
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    assert.equal(await target.evaluate(()=>fixture.panelOpens),0,'隐藏只处理桌宠和菜单');
    await target.evaluate(()=>fixture.pet.showInactive());
    await driver.open();await menu.getByRole('menuitem',{name:'隐藏桌宠',exact:true}).click();
    await waitFor(target,f=>!f.pet.isVisible()&&!f.menu.isOpen());
    assert.equal((await driver.geometry()).visible,false);
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before,
      '鼠标点击隐藏也不能把小屋带到前台');
    assert.equal(await target.evaluate(()=>fixture.panelOpens),0);
    // 从后台小屋场景收纳，再点击真实非激活书签恢复，应用和小屋都不能被带到前台。
    await target.evaluate(()=>fixture.pet.showInactive());
    await driver.open();await menu.getByRole('menuitem',{name:'收纳到边缘',exact:true}).click();
    await waitFor(target,f=>f.storage.isStored()&&f.storage.isVisible()&&!f.pet.isVisible());
    const tab=target.windows().find(page=>page.url().endsWith('/pet-storage.html'));
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    await tab.locator('#pet-storage-tab').click();
    await waitFor(target,f=>!f.storage.isStored()&&f.pet.isVisible());
    // CDP 点击不会完整模拟 macOS 的原生键窗口切换，单独覆盖还原后人物获得焦点的路径。
    await target.evaluate(()=>fixture.pet.focus());
    await waitFor(target,f=>f.pet.isFocused());
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    assert.equal(await cover.evaluate(()=>fixture.active),true,'恢复书签不能抢走其他应用的激活状态');
    await driver.open();await menu.getByRole('menuitem',{name:'收纳到边缘',exact:true}).click();
    await waitFor(target,f=>f.storage.isStored()&&f.storage.isVisible());
    await tab.locator('#pet-storage-tab').click({button:'right'});
    await menu.getByRole('menuitem',{name:'恢复桌宠',exact:true}).click();
    await waitFor(target,f=>!f.storage.isStored()&&f.pet.isVisible());
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    assert.equal(await target.evaluate(()=>fixture.panelOpens),0);
    // 与正式人物窗口一致地允许聚焦，确认新按钮本身也不会把后台小屋带出。
    await target.evaluate(()=>fixture.pet.setFocusable(true));
    await pet.locator('#pet-store-button').click();
    await waitFor(target,f=>f.storage.isStored()&&f.storage.isVisible());
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    await tab.locator('#pet-storage-tab').click();
    await waitFor(target,f=>!f.storage.isStored()&&f.pet.isVisible());
    await target.evaluate(()=>fixture.pet.setFocusable(false));
    await target.evaluate(()=>fixture.pet.showInactive());
    // 额度账号窗和榜单也应只取得键盘焦点，不激活后台小屋。
    await target.evaluate(()=>{
      fixture.windows.chooseTrackingAccount([{id:1,name:'测试一号'},{id:2,name:'测试二号'}],1).then(id=>{fixture.selectedAccount=id;});
    });
    await waitFor(target,f=>f.accountsWindow?.isFocused());
    const accounts=target.windows().find(page=>page.url().endsWith('/pet-accounts.html'));
    await accounts.getByRole('radio',{name:/测试一号/}).waitFor();
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    assert.equal(await cover.evaluate(()=>fixture.active),true,'账号窗不能激活后台小屋');
    await accounts.keyboard.press('ArrowDown');await accounts.keyboard.press('Enter');
    await waitFor(target,f=>f.selectedAccount===2&&!f.accountsWindow.isVisible());
    await target.evaluate(()=>fixture.windows.toggleRanking('primary'));
    await target.evaluate(({BrowserWindow})=>{fixture.rankingWindow=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet-ranking.html'));});
    await waitFor(target,f=>f.rankingWindow?.isFocused());
    const ranking=target.windows().find(page=>page.url().endsWith('/pet-ranking.html'));
    assert.deepEqual(await target.evaluate(()=>({activations:fixture.activations,panelFocus:fixture.panelFocus})),before);
    assert.equal(await cover.evaluate(()=>fixture.active),true,'榜单不能激活后台小屋');
    await ranking.keyboard.press('Escape');await waitFor(target,f=>!f.rankingWindow.isVisible());
    await driver.open();await menu.getByRole('menuitem',{name:'打开小屋',exact:true}).click();
    await waitFor(target,f=>f.panelOpens===1&&f.panel.isFocused()&&f.active);
    await coverPanel();await driver.open();
    await waitFor(target,f=>f.menuWindow.isFocused());
    // 遮挡应用此时仍处于激活态，重复 focus 不等同于菜单失焦；直接验证原生 blur 路径。
    await target.evaluate(()=>fixture.menuWindow.blur());
    await waitFor(target,f=>!f.menu.isOpen());
    assert.equal((await driver.geometry()).visible,false,'菜单失焦仍会关闭');
    await driver.open();await menu.keyboard.press('Escape');
    await waitFor(target,f=>!f.menu.isOpen());
    assert.equal((await driver.geometry()).visible,false,'Esc 仍会关闭菜单');
    assert.deepEqual(errors,[]);
    console.log('Pet menu focus OK: background house preserved, mouse/keyboard hide, store/bookmark/menu restore, account selection, ranking, explicit house opening, blur/Esc dismissal');
  } catch(error) {
    for(const app of apps)console.error(await app.evaluate(({BrowserWindow})=>({events:fixture.events.slice(-24),active:fixture.active,
      windows:BrowserWindow.getAllWindows().map(win=>({id:win.id,visible:win.isVisible(),focused:win.isFocused()}))})));
    throw error;
  } finally {
    for(const app of apps.reverse())await app.close();
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
