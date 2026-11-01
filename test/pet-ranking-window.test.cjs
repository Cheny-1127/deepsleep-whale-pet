'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
function fixture(x = 800) {
  const ipcMain = new EventEmitter(), handlers = new Map(), windows = [];
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  class Window extends EventEmitter {
    constructor(options) {super();this.options=options;this.visible = false;this.bounds = {};this.webContents = {mainFrame:{},setWindowOpenHandler(){}};windows.push(this);}
    isDestroyed() {return false;} isVisible() {return this.visible;} loadFile() {return Promise.resolve();}
    setVisibleOnAllWorkspaces() {} setBounds(value) {this.bounds = value;} getBounds() {return this.bounds;}
    show() {this.visible = true;} hide() {this.visible = false;} focus() {this.focused=true;}
  }
  const anchors = new Map([['pet-art',{left:30,right:190,top:96,bottom:272}],['pet-quota-controls',{left:30,right:190,top:243,bottom:272}],
    ['pet-quota-config-2',{left:30,right:190,top:276,bottom:305}],['pet-quota-config-3',{left:30,right:190,top:309,bottom:338}]]);
  const pet = {isDestroyed:()=>false, isVisible:()=>true, getContentBounds:()=>({x, y:450}), getBounds:()=>({x, y:450, width:220, height:320}),
    webContents:{executeJavaScript:async source=>vm.runInNewContext(source,{document:{getElementById:id=>anchors.has(id)?{getBoundingClientRect:()=>anchors.get(id)}:null}})}};
  const area = {x:0, y:0, width:1200, height:800}, module = {exports:{}};
  const electron = {BrowserWindow:Window, ipcMain, screen:{getDisplayMatching:()=>({workArea:area})}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/app/pet-ranking.cjs'), 'utf8'), {
    module, __dirname:path.join(__dirname, '../src/app'), require:name=>name==='electron'?electron:require(name)
  });
  const api = module.exports.createPetRanking({getPet:()=>pet, snapshot:()=>({users:[]}), refresh:async()=>({refreshed:true}), protect(){}});
  return {api, ipcMain, handlers, windows, pet, area, anchors};
}
test('ranking sits beside the pet, flips at the left edge, fits the screen and shrinks its click area to its content', async () => {
  for (const x of [800, 0]) {
    const f = fixture(x);await f.api.toggle();const panel = f.windows[0], before = f.pet.getContentBounds();
    assert.equal(panel.visible, true);assert.equal(f.api.isOpen(), true);
    assert.equal(panel.options.type,'panel');assert.equal(panel.focused,true,'the nonactivating ranking must retain keyboard focus');
    assert.ok(panel.bounds.x >= 0 && panel.bounds.x + panel.bounds.width <= f.area.width);
    assert.ok(x === 800 ? panel.bounds.x + panel.bounds.width < x + 30 : panel.bounds.x > x + 190);
    const event = {sender:panel.webContents, senderFrame:panel.webContents.mainFrame};
    f.ipcMain.emit('pet-ranking-size', event, 198);assert.equal(panel.bounds.height, 198);
    assert.equal(panel.bounds.y + panel.bounds.height, 722);assert.deepEqual(f.pet.getContentBounds(), before);
    for (const height of [0, 1000, '200', 200.1]) f.ipcMain.emit('pet-ranking-size', event, height);
    f.ipcMain.emit('pet-ranking-size', {...event,senderFrame:{}}, 250);assert.equal(panel.bounds.height, 198);
    assert.throws(() => f.handlers.get('pet-ranking-data')({...event,senderFrame:{}}), /榜单窗口/);
    assert.deepEqual(f.handlers.get('pet-ranking-data')(event), {users:[]});
    assert.throws(() => f.handlers.get('pet-ranking-refresh')({...event,senderFrame:{}}), /榜单窗口/);
    assert.deepEqual(await f.handlers.get('pet-ranking-refresh')(event), {refreshed:true});
    await f.api.toggle();assert.equal(panel.visible, false);assert.equal(f.api.isOpen(), false);
  }
});
test('closing during pending geometry prevents a late popup', async () => {
  const f = fixture();let resolve;
  f.pet.webContents.executeJavaScript = () => new Promise(done => {resolve = done;});
  const task = f.api.toggle();f.api.close();resolve({left:30,right:190,top:96,bottom:272});await task;
  assert.equal(f.windows.length, 0);assert.equal(f.api.isOpen(), false);
});
test('each ranking follows its own quota bar after resizing, flips at edges and stays within the screen', async () => {
  for (const x of [800,0]) {
    const f=fixture(x),bottoms=[];
    for (const id of ['primary',2,3]) {
      await f.api.toggle(id);const panel=f.windows[0],event={sender:panel.webContents,senderFrame:panel.webContents.mainFrame};
      f.ipcMain.emit('pet-ranking-size',event,120);bottoms.push(panel.bounds.y+panel.bounds.height);
      assert.ok(x===800?panel.bounds.x+panel.bounds.width<x+30:panel.bounds.x>x+190);
    }
    assert.deepEqual(bottoms,[722,755,788],'different quota bars must have different popup anchors');
    f.area.height=650;await f.api.toggle(2);const panel=f.windows[0];
    assert.ok(panel.bounds.y>=f.area.y&&panel.bounds.y+panel.bounds.height<=f.area.height);
    assert.equal(f.windows.length,1,'switching bars reuses the popup');
  }
});
test('a removed quota bar cannot open a ranking at the pets unrelated position', async () => {
  const f=fixture();f.anchors.delete('pet-quota-config-2');await f.api.toggle(2);
  assert.equal(f.windows.length,0);assert.equal(f.api.isOpen(),false);
});
