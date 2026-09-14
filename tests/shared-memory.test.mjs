import test from 'node:test';
import assert from 'node:assert/strict';
import { installSharedMemory, sharedMemoryMigration, sharedMemoryOverview } from '../src/shared-memory.js';
import { readFileSync } from 'node:fs';

class Element {
  value='';textContent='';checked=false;disabled=false;readOnly=false;children=[];listeners={};
  classes=new Set();classList={add:v=>this.classes.add(v),remove:v=>this.classes.delete(v)};
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  appendChild(node){this.children.push(node);}
  replaceChildren(){this.children=[];this.value='';}
  focus(){}
  fire(k){return Promise.all((this.listeners[k]||[]).map(fn=>fn({preventDefault(){},key:''})));}
}
function fixture({files=[{name:'MEMORY.md',bytes:10}],index=null}={}){
  const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const calls=[];let content='已确认的项目事实';let enabled=true;let approve=true;
  const controller=installSharedMemory({document:{getElementById:el,createElement:()=>new Element()},confirm:async()=>approve,notify(){},invoke:async(command,payload)=>{
    calls.push({command,payload});
    if(command==='shared_memory_state')return{enabled,directory:'/memory/project',files,warning:''};
    if(command==='shared_memory_read')return{name:payload.name,content:payload.name==='MEMORY.md'&&index!==null?index:content};
    if(command==='shared_memory_backups')return[];
    if(command==='shared_memory_save'){assert.equal(payload.expected,content);content=payload.content;return;}
    if(command==='shared_memory_set_enabled'){enabled=payload.enabled;return;}
    throw new Error(command);
  }});
  return {controller,el,calls,setConfirm(v){approve=v;}};
}

test('旧开关迁移保留空列表/损坏配置的关闭语义，不猜测用户开启',()=>{
  const projects=[{id:'a',localPath:'/a/'},{id:'b',localPath:'/b'}];
  assert.deepEqual(sharedMemoryMigration(projects,'{"paths":["/a"]}'),{legacyPresent:true,enabledProjectIds:['a']});
  assert.deepEqual(sharedMemoryMigration(projects,'{"paths":[]}'),{legacyPresent:true,enabledProjectIds:[]});
  assert.deepEqual(sharedMemoryMigration(projects,'broken'),{legacyPresent:true,enabledProjectIds:[]});
  assert.deepEqual(sharedMemoryMigration(projects,null),{legacyPresent:false,enabledProjectIds:[]});
});

test('普通会话只显示自动状态，文件管理留在开发模式',()=>{
  const html=readFileSync(new URL('../src/index.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('../src/shared-memory.js',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="conversation-memory-open"/);
  assert.match(html,/conversation-memory-indicator/);
  assert.match(html,/id="shared-memory-advanced"[^>]*>[\s\S]*?<summary>查看或编辑记忆文件<\/summary>/);
  assert.doesNotMatch(script,/请打开面板/);
  assert.match(script,/ui\.status\.textContent='读取失败'/);
  const view=sharedMemoryOverview('- [[wow3d]] 莫高雷项目进度',[{name:'MEMORY.md'},{name:'wow3d.md'},{name:'inbox/draft.md'}]);
  assert.deepEqual(view,{count:1,inbox:1,items:[{name:'wow3d.md',text:'莫高雷项目进度'}]});
});

test('概览里的专题点一条就能编辑，并显示上次带入回执',async()=>{
  const f=fixture({files:[{name:'MEMORY.md',bytes:10},{name:'wow3d.md',bytes:20}],index:'- [[wow3d]] 莫高雷项目进度'});
  await f.controller.open({id:'a',name:'项目A'});
  const overview=f.el('shared-memory-overview');
  assert.equal(overview.children.length,1);
  const button=overview.children[0].children[0];
  assert.equal(button.textContent,'莫高雷项目进度');
  await button.fire('click');
  assert.equal(f.el('shared-memory-advanced').open,true,'点专题应展开编辑区');
  const reads=f.calls.filter(c=>c.command==='shared_memory_read');
  assert.equal(reads.at(-1).payload.name,'wow3d.md','读的是被点的那条专题');

  f.controller.record('a',{files:['MEMORY.md','wow3d.md'],bytes:30});
  assert.match(f.el('shared-memory-receipt').textContent,/上次对话带入了 2 个文件/);
  assert.match(f.el('shared-memory-location').textContent,/文件实际在 \/memory\/project/);
  assert.match(f.el('shared-memory-location').textContent,/\.memory 是它的快捷方式/);
});

test('自动进度的七家适配器使用同一结果收集边界',()=>{
  const read=p=>readFileSync(new URL(`../${p}`,import.meta.url),'utf8');
  assert.match(read('src-tauri/src/conversation_chat.rs'),/shared_memory::observe\(app/);
  assert.match(read('src-tauri/src/codex_chat.rs'),/shared_memory::observe/);
  assert.match(read('src-tauri/src/lib.rs'),/shared_memory::begin_auto/);
  assert.match(read('src-tauri/src/lib.rs'),/shared_memory::abort_auto/);
});

test('共享记忆只在用户确认保存时写入，编辑目标固定不随后台项目切换',async()=>{
  const f=fixture();await f.controller.open({id:'a',name:'项目A'});
  assert.equal(f.controller.hasUnsavedChanges(),false);
  f.controller.record('a',{files:['MEMORY.md'],bytes:10});
  assert.equal(f.calls.some(c=>c.command==='shared_memory_save'),false);
  f.el('shared-memory-content').value='新确认的事实';assert.equal(f.controller.hasUnsavedChanges(),true);
  f.controller.setProject({id:'b',name:'项目B'});
  f.setConfirm(false);await f.el('shared-memory-save').fire('click');
  assert.equal(f.calls.some(c=>c.command==='shared_memory_save'),false);
  f.setConfirm(true);await f.el('shared-memory-save').fire('click');
  const save=f.calls.find(c=>c.command==='shared_memory_save');
  assert.equal(save.payload.projectId,'a');assert.equal(save.payload.content,'新确认的事实');
  assert.equal(f.controller.hasUnsavedChanges(),false);
});

test('关闭面板保留未确认草稿，关闭共享需要独立确认',async()=>{
  const f=fixture();await f.controller.open({id:'a',name:'A'});
  f.el('shared-memory-content').value='未保存';f.setConfirm(false);
  await f.el('shared-memory-close').fire('click');assert.ok(f.el('shared-memory-overlay').classes.has('active'));
  f.el('shared-memory-content').value='已确认的项目事实';f.el('shared-memory-enabled').checked=false;
  await f.el('shared-memory-enabled').fire('change');assert.equal(f.calls.some(c=>c.command==='shared_memory_set_enabled'),false);
  f.setConfirm(true);f.el('shared-memory-enabled').checked=false;await f.el('shared-memory-enabled').fire('change');
  assert.deepEqual(f.calls.find(c=>c.command==='shared_memory_set_enabled').payload,{projectId:'a',enabled:false});
});
