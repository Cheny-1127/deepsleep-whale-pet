'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
function fixture(startOptions,{loadTab=()=>Promise.resolve()}={}) {
  const app=new EventEmitter(),ipcMain=new EventEmitter(),handlers=new Map(),windows=[];
  const displays=[{id:1,workArea:{x:0,y:0,width:1000,height:800}}];
  const screen=new EventEmitter();
  screen.getPrimaryDisplay=()=>displays[0];screen.getAllDisplays=()=>displays;
  screen.getDisplayMatching=bounds=>displays.find(display=>bounds.x>=display.workArea.x&&bounds.x<display.workArea.x+display.workArea.width)||displays[0];
  screen.getCursorScreenPoint=()=>({x:810,y:500});
  const data={state:'idle',activity:{pending:0,unread:0,working:0},planner:{active:[]}};
  ipcMain.handle=(name,handler)=>handlers.set(name,handler);
  class Window extends EventEmitter {
    constructor(options){super();this.options=options;this.bounds={...options};this.ignored=[];this.visible=options.show!==false;this.messages=[];
      this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.setWindowOpenHandler=()=>{};
      this.webContents.send=(...args)=>this.messages.push(args);windows.push(this);}
    loadFile(file){return file.endsWith('pet-storage.html')?loadTab():Promise.resolve();}
    setVisibleOnAllWorkspaces(){}isDestroyed(){return Boolean(this.destroyed);}isVisible(){return this.visible;}
    destroy(){this.destroyed=true;this.visible=false;this.emit('closed');}
    hide(){this.visible=false;this.emit('hide');}showInactive(){this.visible=true;this.emit('show');}
    show(){this.visible=true;this.emit('show');}focus(){this.focused=true;}
    setIgnoreMouseEvents(ignore,options){this.ignored.push({ignore,...options});}
    getBounds(){const {x,y,width,height}=this.bounds;return {x,y,width,height};}getContentBounds(){return this.getBounds();}
    setPosition(x,y){Object.assign(this.bounds,{x,y});this.emit('move');}
    setBounds(bounds){this.bounds=bounds;this.emit('resize');}
  }
  class Tray extends EventEmitter {setContextMenu(){}setToolTip(){}isDestroyed(){return false;}}
  let screenReady=false;
  const guardedScreen=new Proxy(screen,{get(target,key){if(!screenReady)throw Error('screen accessed before app ready');return Reflect.get(target,key);}});
  const electron={app,ipcMain,BrowserWindow:Window,Tray,Menu:{buildFromTemplate:v=>v,setApplicationMenu(){}},
    nativeImage:{createFromPath:()=>({resize:()=>({})})},screen:guardedScreen};
  const module={exports:{}};
  const source=fs.readFileSync(path.join(__dirname,'../src/app/windows.cjs'),'utf8');
  vm.runInNewContext(source,{module,__dirname:path.join(__dirname,'../src/app'),require:name=>name==='electron'?electron:name==='./pet-menu.cjs'?
    {createPetMenu:()=>({close(){},open(){},isOpen:()=>false,refresh(){}})}:name==='./pet-ranking.cjs'?{createPetRanking:()=>({close(){},toggle(){},isOpen:()=>false})}:name==='./pet-storage.cjs'?(()=>{
      const storageModule={exports:{}};
      vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/app/pet-storage.cjs'),'utf8'),{
        module:storageModule,__dirname:path.join(__dirname,'../src/app'),require:id=>id==='electron'?electron:require(id)});
      return storageModule.exports;
    })():require(name)});
  const api=module.exports.createWindows({snapshot:()=>data,performAction(){},collapseReminders(){}});
  screenReady=true;api.start(startOptions);
  const panel=windows.find(win=>win.bounds.width===1060),pet=windows.find(win=>win.bounds.width===220),event={sender:pet.webContents,senderFrame:pet.webContents.mainFrame};
  return {ipcMain,handlers,api,panel,pet,event,windows,app,screen,displays,data};
}
test('window controllers can be assembled before Electron screen is ready',()=>{
  assert.doesNotThrow(()=>fixture({showPanelOnStartup:false}));
});
test('pet starts click-through, enables visible hit targets and forwards movement while ignoring clicks',()=>{
  const f=fixture();assert.equal(f.pet.ignored.at(-1)?.ignore,true,'transparent startup area must not block other apps');
  f.ipcMain.emit('pet-interactive',f.event,true);assert.equal(f.pet.ignored.at(-1).ignore,false);
  f.ipcMain.emit('pet-interactive',f.event,false);assert.equal(f.pet.ignored.at(-1).ignore,true);
  assert.equal(f.pet.ignored.at(-1).forward,true);
  const count=f.pet.ignored.length;
  f.ipcMain.emit('pet-interactive',{sender:f.panel.webContents,senderFrame:f.panel.webContents.mainFrame},true);
  f.ipcMain.emit('pet-interactive',{...f.event,senderFrame:{}},true);
  f.ipcMain.emit('pet-interactive',f.event,'false');assert.equal(f.pet.ignored.length,count);
});
test('dragging keeps capture even over transparent regions and restores requested pass-through on release',()=>{
  const f=fixture();f.ipcMain.emit('pet-drag',f.event,'start',{x:800,y:500});
  f.ipcMain.emit('pet-interactive',f.event,false);assert.equal(f.pet.ignored.at(-1).ignore,false);
  f.ipcMain.emit('pet-drag',f.event,'move',{x:850,y:540});assert.equal(f.pet.bounds.x,810);assert.equal(f.pet.bounds.y,500);
  f.ipcMain.emit('pet-drag',f.event,'end');assert.equal(f.pet.ignored.at(-1).ignore,true);
});
test('cursor query uses content coordinates and rejects the panel and child frames',()=>{
  const f=fixture(),query=f.handlers.get('pet-pointer');assert.equal(typeof query,'function');
  assert.deepEqual(JSON.parse(JSON.stringify(query(f.event))),{x:50,y:40});
  assert.equal(query({sender:f.panel.webContents,senderFrame:f.panel.webContents.mainFrame}),null);
  assert.equal(query({...f.event,senderFrame:{}}),null);
});

test('hiding and showing retains the renderer hit state so a stationary cursor over the pet stays clickable',()=>{
  const f=fixture();f.ipcMain.emit('pet-interactive',f.event,true);
  f.pet.emit('hide');f.pet.emit('show');
  assert.equal(f.pet.ignored.at(-1).ignore,false,'renderer may deduplicate the unchanged true hit state after show');
});
test('startup can omit the panel completely while explicit opening still creates it',()=>{
  const f=fixture({showPanelOnStartup:false});
  assert.equal(f.windows.length,1);assert.equal(f.panel,undefined);assert.equal(f.api.isPetVisible(),true);
  f.api.showPanel();
  assert.equal(f.windows.length,2);assert.equal(f.api.isPanel(f.windows[1].webContents),true);
});
test('account picker skips opening when at most one account is available',async()=>{
  const f=fixture({showPanelOnStartup:false});
  for(const accounts of [[],[{id:1,name:'唯一账号'}]]) {
    assert.equal(await f.api.chooseTrackingAccount(accounts,1),null);
    assert.equal(f.windows.length,1,'must not create an account picker window');
  }
});
test('account picker uses a nonactivating panel and still accepts an account selection',async()=>{
  const f=fixture();f.pet.webContents.executeJavaScript=async()=>({left:30,right:190,bottom:272});
  const selection=f.api.chooseTrackingAccount([{id:1,name:'一号'},{id:2,name:'二号'}],1);
  await new Promise(resolve=>setImmediate(resolve));
  const picker=f.windows.find(win=>win.options.width===300);
  assert.equal(picker.options.type,'panel');assert.equal(picker.isVisible(),true);assert.equal(picker.focused,true);
  assert.equal(f.panel.focused,undefined,'opening the picker must not focus the house');
  const event={sender:picker.webContents,senderFrame:picker.webContents.mainFrame};
  f.ipcMain.emit('pet-accounts-select',{...event,senderFrame:{}},2);
  assert.equal(picker.isVisible(),true,'child frames cannot select an account');
  f.ipcMain.emit('pet-accounts-select',event,2);
  assert.equal(await selection,2);assert.equal(picker.isVisible(),false);
});

test('storing releases the character window and restores its position without opening the panel',async()=>{
  const f=fixture({showPanelOnStartup:false}),before={...f.pet.getBounds()};
  assert.equal(typeof f.api.storePet,'function','the pet needs an explicit storage action');
  await f.api.storePet();
  const tab=f.windows.find(win=>win!==f.pet);
  assert.equal(f.pet.isVisible(),false);assert.equal(tab.isVisible(),true);
  assert.equal(f.api.isPetVisible(),true,'the bookmark is still a visible pet entry');
  assert.ok(tab.bounds.width<=36&&tab.bounds.height<=80,'storage must release the original large hit area');
  assert.equal(tab.bounds.x+tab.bounds.width,1000,'store at the nearest work-area edge');
  f.api.showPet();
  assert.equal(tab.isVisible(),false);assert.equal(f.pet.isVisible(),true);
  assert.deepEqual(f.pet.getBounds(),before);
  assert.equal(f.windows.length,2,'restoring must not create a house window');
});

test('task broadcasts update bookmark attention while keeping the character stored',async()=>{
  const f=fixture({showPanelOnStartup:false});await f.api.storePet();
  const tab=f.windows[1],bounds={...tab.getBounds()},characterBounds={...f.pet.getBounds()};
  f.data.activity.pending=2;f.data.activity.unread=3;
  f.api.broadcast(f.data);
  assert.equal(f.pet.isVisible(),false);assert.deepEqual(f.pet.getBounds(),characterBounds);
  assert.deepEqual(tab.getBounds(),bounds);
  const state=tab.messages.filter(message=>message[0]==='pet-storage-state').at(-1)[1];
  assert.equal(state.attention,true);assert.equal(state.stored,true);
  f.data.activity.pending=0;f.data.activity.unread=0;f.api.broadcast(f.data);
  assert.equal(tab.messages.filter(message=>message[0]==='pet-storage-state').at(-1)[1].attention,false);
});

test('bookmark drag snaps to the other edge without moving the stored character',async()=>{
  const f=fixture({showPanelOnStartup:false}),before={...f.pet.getBounds()};await f.api.storePet();
  const tab=f.windows[1],event={sender:tab.webContents,senderFrame:tab.webContents.mainFrame};
  f.ipcMain.emit('pet-storage-drag',event,'start',{x:985,y:620});
  f.ipcMain.emit('pet-storage-drag',event,'move',{x:15,y:300});
  f.ipcMain.emit('pet-storage-drag',event,'end');
  assert.equal(tab.bounds.x,0);assert.ok(tab.bounds.y>=0&&tab.bounds.y+tab.bounds.height<=800);
  assert.equal(f.pet.isVisible(),false);f.api.showPet();assert.deepEqual(f.pet.getBounds(),before);
});

test('storage chooses the nearest of all four work-area edges',async()=>{
  for(const [side,position] of Object.entries({left:{x:-20,y:240},right:{x:800,y:240},top:{x:400,y:-20},bottom:{x:400,y:600}})) {
    const f=fixture({showPanelOnStartup:false});f.pet.setPosition(position.x,position.y);await f.api.storePet();
    const tab=f.windows[1],state=f.handlers.get('pet-storage')(f.event,'snapshot');
    assert.equal(state.side,side);
    if(side==='left')assert.equal(tab.bounds.x,0);
    if(side==='right')assert.equal(tab.bounds.x+tab.bounds.width,1000);
    if(side==='top')assert.equal(tab.bounds.y,0);
    if(side==='bottom')assert.equal(tab.bounds.y+tab.bounds.height,800);
    assert.equal(tab.bounds.width>tab.bounds.height,['top','bottom'].includes(side));
  }
});

test('moving the restored character overrides the previous docking edge',async()=>{
  const f=fixture({showPanelOnStartup:false});await f.api.storePet();f.api.showPet();
  f.pet.setPosition(0,240);await f.api.storePet();
  assert.equal(f.windows[1].bounds.x,0,'a new character position must not be overridden by the old right edge');
});

test('a manually adjusted bookmark position is retained while the character stays in place',async()=>{
  const f=fixture({showPanelOnStartup:false});await f.api.storePet();
  const tab=f.windows[1],event={sender:tab.webContents,senderFrame:tab.webContents.mainFrame};
  f.ipcMain.emit('pet-storage-drag',event,'start',{x:985,y:620});
  f.ipcMain.emit('pet-storage-drag',event,'move',{x:15,y:300});
  f.ipcMain.emit('pet-storage-drag',event,'end');
  const adjusted=tab.getBounds();f.api.showPet();await f.api.storePet();assert.deepEqual(tab.getBounds(),adjusted);
});

test('bookmark IPC rejects other windows and subframes; hide/show keeps a recovery path',async()=>{
  const f=fixture();await f.api.storePet();const tab=f.windows[2],handle=f.handlers.get('pet-storage');
  const foreign={sender:f.panel.webContents,senderFrame:f.panel.webContents.mainFrame};
  assert.throws(()=>handle(foreign,'restore'),/桌宠/);
  assert.throws(()=>handle({sender:tab.webContents,senderFrame:{}},'restore'),/桌宠/);
  assert.equal(f.pet.isVisible(),false);
  f.api.hidePet();assert.equal(tab.isVisible(),false);assert.equal(f.api.isPetVisible(),false);
  f.api.showPet();assert.equal(f.pet.isVisible(),true);assert.equal(tab.isVisible(),false);
});

test('removing a display relocates the bookmark and restores the pet onto an available display',async()=>{
  const f=fixture({showPanelOnStartup:false});await f.api.storePet();
  const tab=f.windows[1];f.displays.splice(0,1,{id:2,workArea:{x:-1200,y:-200,width:1200,height:700}});
  f.screen.emit('display-removed');
  assert.ok(tab.bounds.x>=-1200&&tab.bounds.x+tab.bounds.width<=0);
  assert.ok(tab.bounds.y>=-200&&tab.bounds.y+tab.bounds.height<=500);
  f.api.showPet();
  assert.ok(f.pet.bounds.x>=-1200&&f.pet.bounds.x+f.pet.bounds.width<=0);
  assert.ok(f.pet.bounds.y>=-200&&f.pet.bounds.y+f.pet.bounds.height<=500);
});

test('hiding or restoring during bookmark loading cancels the late storage request',async()=>{
  for(const action of ['hidePet','showPet']) {
    let resolve;
    const f=fixture({showPanelOnStartup:false},{loadTab:()=>new Promise(done=>resolve=done)});
    const storing=f.api.storePet();f.api[action]();resolve();await storing;
    assert.equal(f.windows[1].isVisible(),false,'a cancelled load must not show the bookmark');
    assert.equal(f.pet.isVisible(),action==='showPet');
  }
});

test('a failed bookmark load keeps the character available and the next store can retry',async()=>{
  let attempts=0;
  const f=fixture({showPanelOnStartup:false},{loadTab:()=>++attempts===1?Promise.reject(Error('load failed')):Promise.resolve()});
  await assert.rejects(f.api.storePet(),/load failed/);
  assert.equal(f.pet.isVisible(),true);assert.equal(f.windows[1].isDestroyed(),true);
  await f.api.storePet();assert.equal(f.pet.isVisible(),false);assert.equal(f.windows[2].isVisible(),true);
});
