// Shared by conversation and developer surfaces. Every mutation targets a saved
// project ID and requires an explicit user action; model messages never auto-save.
export function sharedMemoryMigration(projects, raw) {
  let paths=[];
  try { const value=JSON.parse(raw);if(Array.isArray(value?.paths))paths=value.paths.map(p=>String(p).replace(/[\\/]+$/,'')); } catch {}
  return { legacyPresent:raw!==null&&raw!==undefined, enabledProjectIds:(projects||[]).filter(p=>paths.includes(String(p.localPath||'').replace(/[\\/]+$/,''))).map(p=>p.id) };
}

export function sharedMemoryOverview(index, files) {
  const topics=(files||[]).filter(file=>file.name!=='MEMORY.md'&&!file.name.startsWith('inbox/'));
  const descriptions=new Map();
  for(const line of String(index||'').split('\n')) {
    const wiki=line.match(/^\s*-\s*\[\[([^\]]+)\]\]\s*(.*)/);
    const markdown=line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(.*)/);
    if(wiki)descriptions.set(wiki[1].endsWith('.md')?wiki[1]:`${wiki[1]}.md`,wiki[2]||wiki[1]);
    else if(markdown)descriptions.set(markdown[2],`${markdown[1]} ${markdown[3]}`.trim());
  }
  return { count:topics.length, inbox:(files||[]).filter(f=>f.name.startsWith('inbox/')).length,
    items:topics.slice(0,6).map(file=>({name:file.name,text:(descriptions.get(file.name)||file.name.replace(/\.md$/,'').replace(/[-_]/g,' ')).slice(0,160)})) };
}

export function installSharedMemory({document,invoke,confirm,notify,onFloating}) {
  const el=id=>document.getElementById(id);
  const ui={open:el('conversation-memory-open'),status:el('conversation-memory-status'),overlay:el('shared-memory-overlay'),project:el('shared-memory-project'),enabled:el('shared-memory-enabled'),directory:el('shared-memory-directory'),files:el('shared-memory-files'),name:el('shared-memory-name'),content:el('shared-memory-content'),save:el('shared-memory-save'),fresh:el('shared-memory-new'),close:el('shared-memory-close'),reload:el('shared-memory-reload'),backups:el('shared-memory-backups'),restore:el('shared-memory-restore'),message:el('shared-memory-message')};
  let current=null, editing=null, expected=null, loadedName='', busy=false, revision=0, initialText='', initialName='';
  const overview=el('shared-memory-overview'),summary=el('shared-memory-summary'),advanced=el('shared-memory-advanced'),feedback=el('shared-memory-feedback'),receipt=el('shared-memory-receipt'),overviewHint=el('shared-memory-overview-hint');
  let memoryFiles=[],indexText='',recentCount=0;
  const receipts=new Map();
  const policies=new Map(),saveStates=new Map();let sidebarRevision=0;
  const dirty=()=>Boolean(editing&&(busy||ui.content?.value!==initialText||ui.name?.value!==initialName));
  function message(text,error=false){if(ui.message)ui.message.textContent=text;if(feedback)feedback.textContent=error?text:'';}
  /// 「上次对话实际带上了什么」——比抽象开关更能回答"它到底发没发、发了啥"。
  function renderReceipt(){
    if(!receipt)return;
    const entry=editing&&receipts.get(editing.id);
    if(!entry){receipt.textContent='还没有附加记录：下次对话会自动读取，并在完成后显示带入了哪些文件。';return;}
    if(entry.enabled===false){receipt.textContent='共享已关闭，后续对话不再附加记忆。';return;}
    const files=(entry.files||[]).filter(Boolean);
    const head=files.length?`上次对话带入了 ${files.length} 个文件：${files.slice(0,3).join('、')}${files.length>3?' 等':''}`:'上次对话没有匹配到可读取的专题';
    receipt.textContent=entry.warning?`${head}（${entry.warning}）`:head;
  }
  function renderOverview(){
    const view=sharedMemoryOverview(indexText,memoryFiles);
    if(summary)summary.textContent=(view.count?`${view.count} 个记忆专题`:memoryFiles.length?'只有索引，还没有独立专题':'还没有人工专题')+(view.inbox?` · ${view.inbox} 条 inbox 待整理（不自动发送）`:'')+(recentCount?` · ${recentCount} 条自动进度`:'');
    if(overview){
      overview.replaceChildren();
      view.items.forEach(item=>{
        const row=document.createElement('li');
        const button=document.createElement('button');
        button.type='button';
        button.className='shared-memory-topic';
        button.textContent=item.text;
        button.addEventListener('click',()=>openTopic(item.name));
        row.appendChild(button);
        overview.appendChild(row);
      });
    }
    if(overviewHint){
      overviewHint.hidden=view.items.length===0;
      overviewHint.textContent=view.count>view.items.length
        ?`点一条可在下面查看或编辑；还有 ${view.count-view.items.length} 个专题在下面的文件列表里。inbox 草稿不会自动发送。`
        :'点一条可在下面查看或编辑；inbox 草稿不会自动发送。';
    }
    renderReceipt();
  }
  /// 点一条专题直接进编辑器：把"查看"和"编辑"合成一个动作，不用先找下拉框。
  async function openTopic(name){
    if(!name||busy||!editing)return;
    if(!await leave())return;
    if(advanced)advanced.open=true;
    if(ui.files)ui.files.value=name;
    await readName(name);
  }
  function controls(){
    [ui.files,ui.name,ui.content,ui.save,ui.fresh,ui.reload,ui.enabled,ui.backups,ui.restore].forEach(node=>{if(node)node.disabled=busy||!editing;});
    if(ui.name)ui.name.readOnly=Boolean(loadedName);
    if(ui.restore)ui.restore.disabled=busy||!ui.backups?.value;
  }
  async function leave(){return !dirty()||(!busy&&await confirm({title:'记忆修改尚未保存',message:'放弃当前草稿吗？已保存的记忆不会改变。',confirmText:'放弃草稿',danger:true}));}
  function addOption(select,value,text){const option=document.createElement('option');option.value=value;option.textContent=text;select.appendChild(option);}
  function sidebar(){
    if(ui.open)ui.open.disabled=!current;
    if(!ui.status)return;
    const receipt=current&&receipts.get(current.id);
    ui.status.textContent=!current?'未选择项目':policies.get(current.id)===false||receipt?.enabled===false?'已关闭':saveStates.get(current.id)===false?'暂未保存':'自动';
    ui.status.title=receipt?`最近读取：${receipt.files?.join('、')||'无'}${receipt.warning?`；${receipt.warning}`:''}`:'自动读取项目资料，完成任务后记录简短进度。内容会发送给所选模型；开发模式可关闭。';
  }
  async function loadBackups(token){
    ui.backups.replaceChildren();addOption(ui.backups,'','选择历史版本');
    if(!loadedName){controls();return;}
    const rows=await invoke('shared_memory_backups',{projectId:editing.id,name:loadedName});
    if(token!==revision)return;
    rows.forEach(row=>addOption(ui.backups,row.id,new Date(row.at).toLocaleString()));controls();
  }
  async function readName(name){
    const token=++revision;busy=true;controls();message('正在读取…');
    try{
      const doc=await invoke('shared_memory_read',{projectId:editing.id,name});
      if(token!==revision)return;
      expected=doc.content;loadedName=doc.content===null?'':name;
      ui.name.value=name;ui.content.value=doc.content||'';initialName=name;initialText=ui.content.value;
      if(name==='MEMORY.md'){indexText=doc.content||'';renderOverview();}
      await loadBackups(token);message(doc.content===null?'新文件，填写后明确保存。':'记忆只作为项目资料。保存后可能被当前项目的其他 CLI 使用。');
    }catch(error){if(token===revision)message(error?.message||String(error),true);}
    finally{if(token===revision){busy=false;controls();}}
  }
  async function refresh(selectName){
    const token=++revision;busy=true;controls();
    try{
      const state=await invoke('shared_memory_state',{projectId:editing.id});if(token!==revision)return;
      ui.enabled.checked=state.enabled;ui.directory.textContent=state.directory;
      memoryFiles=state.files;recentCount=state.recentCount||0;renderOverview();
      policies.set(editing.id,state.enabled);sidebar();
      ui.files.replaceChildren();addOption(ui.files,'','选择记忆文件');
      state.files.forEach(file=>addOption(ui.files,file.name,`${file.name}${file.name.startsWith('inbox/')?'（待整理，不自动读取）':''}`));
      const name=selectName||state.files.find(f=>f.name==='MEMORY.md')?.name||state.files[0]?.name;
      busy=false;
      if(name){ui.files.value=name;await readName(name);}
      else{loadedName='';expected=null;ui.name.value='MEMORY.md';ui.content.value='';initialName=ui.name.value;initialText='';message('尚无项目记忆。可以新建 MEMORY.md 索引；不会自动合并其他 CLI 的历史。');}
      if(state.warning)message(state.warning,true);
    }catch(error){if(token===revision)message(error?.message||String(error),true);}
    finally{busy=false;controls();}
  }
  async function close(){if(!await leave())return;revision++;editing=null;ui.overlay.classList.remove('active');void onFloating?.(false);sidebar();}
  async function open(project=current){
    if(!project){notify?.('请先选择或登记一个项目','info');return;}
    if(editing&&!await leave())return;
    if(await onFloating?.(true)===false)return;
    editing={...project};memoryFiles=[];indexText='';recentCount=0;loadedName='';expected=null;initialName='';initialText='';ui.name.value='';ui.content.value='';renderOverview();if(advanced)advanced.open=false;
    ui.project.textContent=project.name||project.localPath;ui.overlay.classList.add('active');await refresh();ui.enabled.focus();
  }
  ui.open?.addEventListener('click',()=>void open());
  ui.close?.addEventListener('click',()=>void close());
  ui.overlay?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();void close();}});
  ui.files?.addEventListener('change',async()=>{const name=ui.files.value;if(!name)return;if(!await leave()){ui.files.value=loadedName;return;}await readName(name);});
  ui.reload?.addEventListener('click',async()=>{if(await leave())await refresh(loadedName||undefined);});
  ui.fresh?.addEventListener('click',async()=>{if(!await leave())return;revision++;loadedName='';expected=null;ui.name.value='';ui.content.value='';initialName='';initialText='';ui.files.value='';ui.backups.replaceChildren();addOption(ui.backups,'','选择历史版本');controls();ui.name.focus();message('使用 MEMORY.md、主题名.md 或 inbox/待整理.md。inbox 内容不会自动发给模型。');});
  ui.backups?.addEventListener('change',controls);
  ui.restore?.addEventListener('click',async()=>{
    if(!ui.backups.value||busy||!await leave())return;const token=++revision;busy=true;controls();
    try{const doc=await invoke('shared_memory_read_backup',{projectId:editing.id,name:loadedName,backupId:ui.backups.value});if(token!==revision)return;ui.content.value=doc.content||'';message('历史版本已载入草稿；点击“确认保存”才会恢复，当前版本会另留备份。');}
    catch(error){message(error?.message||String(error));}finally{busy=false;controls();}
  });
  ui.enabled?.addEventListener('change',async()=>{
    const enabled=ui.enabled.checked;if(!await leave()){ui.enabled.checked=!enabled;return;}
    const allowed=await confirm({title:enabled?'启用项目共享记忆':'关闭项目共享记忆',message:enabled?'相关记忆会随请求发送给当前 CLI 对应的模型服务。请勿存放密码、令牌或未经允许共享的资料。启用会关联 .memory 并更新项目中的记忆指引。':'后续请求不再附加共享记忆，也会解除开发模式的关联。文件不会删除；已进入 CLI 历史的内容无法撤回。',confirmText:enabled?'启用':'关闭'});
    if(!allowed){ui.enabled.checked=!enabled;return;}busy=true;controls();
    try{await invoke('shared_memory_set_enabled',{projectId:editing.id,enabled});receipts.delete(editing.id);await refresh();sidebar();}
    catch(error){ui.enabled.checked=!enabled;message(error?.message||String(error));}
    finally{busy=false;controls();}
  });
  ui.save?.addEventListener('click',async()=>{
    if(busy||!editing)return;const name=ui.name.value.trim(),content=ui.content.value;
    if(!await confirm({title:'保存项目共享记忆',message:`确认将 ${name||'此文件'} 保存为当前项目的共享资料？其他 CLI 后续可能读取；旧版本会备份。`,confirmText:'确认保存'}))return;
    busy=true;controls();
    try{await invoke('shared_memory_save',{projectId:editing.id,name,content,expected});loadedName=name;expected=content;initialName=name;initialText=content;await refresh(name);message('已保存。下次发送会按最新索引和专题重新读取。');}
    catch(error){message(error?.message||String(error));}
    finally{busy=false;controls();}
  });
  sidebar();
  return {open,setProject(project){
    current=project||null;const token=++sidebarRevision;sidebar();
    if(current)void invoke('shared_memory_state',{projectId:current.id}).then(state=>{if(token!==sidebarRevision)return;policies.set(current.id,state.enabled);sidebar();}).catch(()=>{if(token===sidebarRevision&&ui.status)ui.status.textContent='读取失败';});
  },record(projectId,receipt){receipts.set(projectId,receipt);sidebar();if(editing&&editing.id===projectId)renderReceipt();},saved(projectId,result){if(result.saved||!result.ok)saveStates.set(projectId,result.ok);sidebar();},hasUnsavedChanges:dirty};
}
