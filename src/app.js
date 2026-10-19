import { uid, loadSource, pageInfo, renderSource, suggestions, selectedText, cropRegion, textRegion, aiImage, cropAssetRegion, createWorksheet, renderPreview } from './pdf-engine.js';
import { normalizeRect, PAPER } from './layout.js';
import { validateAiPlan } from './ai-plan.js';
import { DEFAULT_SETTINGS, DEFAULT_PROBLEM, loadPreferences, savePreferences } from './preferences.js';

const $ = selector => document.querySelector(selector);
const preferences = loadPreferences();
const state = { sources: [], sourceId: null, page: 1, problems: [], selected: null, crop: null, suggestions: [], revision: 0, preview: null, busy: false, view: 'edit', info: null, defaults: { ...preferences.problem } };
const source = () => state.sources.find(s => s.id === state.sourceId);
const selected = () => state.problems.find(p => p.id === state.selected);
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let textEditor = null;
let aiEditor = null;
const settings = () => ({ title: $('#worksheet-title').value, paper: $('#paper-size').value, margin: Number($('#page-margin').value), nameLine: $('#name-line').checked, alignment: $('#question-alignment').value, spacing: $('#page-spacing').value, numbering: $('#number-problems').checked });
function applyWorksheetSettings(value) {
  $('#worksheet-title').value = value.title;
  $('#paper-size').value = value.paper;
  $('#page-margin').value = value.margin;
  $('#name-line').checked = value.nameLine;
  $('#question-alignment').value = value.alignment;
  $('#page-spacing').value = value.spacing;
  $('#number-problems').checked = value.numbering;
}
function rememberSettings() {
  const saved = savePreferences({ worksheet: settings(), problem: state.defaults });
  const p = state.defaults;
  $('#settings-status').textContent = `Next problem: ${+(p.space / 72).toFixed(3)} in space · ${p.scale}% size · ${p.fit === 'shrink' ? 'fit to page' : 'continue if needed'}${p.pageBreak ? ' · new page' : ''}. ${saved ? 'Saved on this device.' : 'Kept for this visit; browser storage is unavailable.'}`;
  $('#spacing-hint').textContent = settings().spacing === 'compact' ? 'Writing space stays at the entered height.' : 'Spare room is shared below whole problems.';
}
function tell(message, error = false) { $('#notice').textContent = message; $('#notice').classList.toggle('error', error); $('#notice').hidden = false; }
function dirty() { state.revision++; $('#preview-count').textContent = state.preview ? 'Changed' : ''; updateButtons(); }
function updateButtons() {
  const empty = !state.problems.length;
  for (const id of ['#export-top','#export-button','#preview-button']) $(id).disabled = empty || state.busy;
  $('#append-region').disabled = !selected();
}
async function runBusy(message, fn) {
  if (state.busy) return false;
  state.busy = true; $('#busy-text').textContent = message; $('#busy').hidden = false; $('main').inert = true; updateButtons();
  try { await fn(); return true; }
  catch (error) { tell(error?.message || 'Something went wrong. Please try again.', true); return false; }
  finally { state.busy = false; $('main').inert = false; $('#busy').hidden = true; updateButtons(); }
}
function newProblem(region) { return { id: uid(), regions: [region], ...state.defaults }; }
async function addFiles(files) {
  await runBusy('Opening files…', async () => {
    const errors = []; let last;
    for (const file of files) {
      try { last = await loadSource(file); state.sources.push(last); }
      catch (error) { errors.push(`${file.name}: ${error.message}`); }
    }
    if (last) { state.sourceId=last.id; state.page=1; state.crop=null; state.suggestions=[]; renderSources(); await showSource(); }
    if (errors.length) tell(errors.join(' '), true);
    else if(last) tell('Drag around a question to select it. Use multiple regions for a question that continues onto another page.');
  });
}
function renderSources() {
  $('#source-select').replaceChildren(...state.sources.map(s => { const o=document.createElement('option');o.value=s.id;o.textContent=s.name;return o; }));
  $('#source-select').value=state.sourceId;
  $('#empty-source').hidden=!!source(); $('#source-workspace').hidden=!source();
}
async function showSource() {
  const s=source(); if(!s) return;
  $('#page-label').textContent=`Page ${state.page} of ${s.pages}`;
  $('#prev-page').disabled=state.page<=1; $('#next-page').disabled=state.page>=s.pages;
  state.info=await pageInfo(s,state.page);
  await renderSource(s,state.page,$('#source-canvas'),Math.max(650,$('.source-panel').clientWidth-32));
  renderOverlay(); renderCropEditor(); renderSuggestions();
}
function rectStyle(rect) { return `left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.w*100}%;height:${rect.h*100}%`; }
function renderOverlay() {
  const boxes=[];
  for(const [i,p] of state.problems.entries()) for(const r of p.regions) {
    if(r.sourceId !== state.sourceId || r.page !== state.page || !r.rect || state.crop?.regionId===r.id) continue;
    boxes.push(`<div class="crop-box saved" data-region="${r.id}" data-problem="${p.id}" style="${rectStyle(r.rect)}"><span class="crop-tag">${i+1}</span></div>`);
  }
  for(const [i,s] of state.suggestions.entries()) {
    if(state.crop?.suggestionId===s.id) continue;
    boxes.push(`<div class="crop-box suggestion" data-suggestion="${s.id}" style="${rectStyle(s)}"><span class="crop-tag">Suggested ${i+1}</span></div>`);
  }
  if(state.crop) boxes.push(`<div class="crop-box active" style="${rectStyle(state.crop.rect)}"><span class="crop-tag">${state.crop.regionId?'Edit region':state.crop.suggestionId?'Review suggestion':'New selection'}</span>${['nw','ne','sw','se'].map(h=>`<span class="handle ${h}" data-handle="${h}"></span>`).join('')}</div>`);
  $('#crop-layer').innerHTML=boxes.join('');
}
function renderCropEditor() {
  const c=state.crop; $('#crop-editor').hidden=!c;
  if(!c) return;
  $('#crop-title').textContent=c.regionId?'Edit saved region':c.suggestionId?'Review suggested region':'New selection';
  for(const field of ['x','y','w','h']) $(`#crop-${field}`).value=(c.rect[field]*100).toFixed(1);
  $('#update-region').hidden=!c.regionId;
  $('#add-problem').hidden=!!c.regionId; $('#append-region').hidden=!!c.regionId;
  $('#reflow-text').hidden=!!c.regionId;
  $('#ai-format').hidden=!!c.regionId;
  updateButtons();
}
function syncSuggestion() {
  if(state.crop?.suggestionId) { const s=state.suggestions.find(s=>s.id===state.crop.suggestionId); if(s) Object.assign(s,state.crop.rect); }
}
function setCrop(rect, details={}) { state.crop={rect:normalizeRect(rect),...details};syncSuggestion();renderOverlay();renderCropEditor();renderSuggestions(); }
function renderSuggestions() {
  const bar=$('#suggestion-bar');bar.hidden=!state.suggestions.length;
  if(bar.hidden) return;
  bar.innerHTML=`<strong>${state.suggestions.length} suggestions</strong> · Check every outline, including diagrams and continuation text. Click an outline to adjust it.<br><button class="button small" id="accept-all">Add all suggestions</button><button class="button small" id="discard-suggestions">Discard all</button>${state.crop?.suggestionId?'<button class="button small" id="reject-suggestion">Remove selected suggestion</button>':''}`;
}
function renderQueue() {
  $('#problem-count').textContent=state.problems.length;
  $('#empty-queue').hidden=!!state.problems.length;
  $('#problem-list').innerHTML=state.problems.map((p,i)=>`<li class="problem-card${p.id===state.selected?' selected':''}" data-id="${p.id}" tabindex="0" aria-label="Problem ${i+1}">
    <div class="card-head"><div class="card-label"><span class="problem-number">${String(i+1).padStart(2,'0')}</span>Problem ${i+1}<span class="quiet">${p.regions.length>1?`${p.regions.length} parts`:''}</span></div><div class="card-actions"><button class="icon-button" data-action="up" aria-label="Move problem ${i+1} up" ${i===0?'disabled':''}>↑</button><button class="icon-button" data-action="down" aria-label="Move problem ${i+1} down" ${i===state.problems.length-1?'disabled':''}>↓</button><button class="icon-button" data-action="remove" aria-label="Remove problem ${i+1}">×</button></div></div>
    <div class="region-list">${p.regions.map((r,ri)=>`<div class="region-thumb"><img src="${r.thumbnail}" alt="Problem ${i+1}, region ${ri+1}"><div class="region-caption"><span title="${escape(r.sourceName)}">${escape(r.sourceName)}${r.sourceId?` · p. ${r.page}`:''}</span><div class="region-actions">${r.sourceId?`<button data-action="edit-region" data-region="${r.id}" aria-label="Edit region ${ri+1} of problem ${i+1}">Crop</button>`:''}${typeof r.text==='string'?`<button data-action="edit-text" data-region="${r.id}" aria-label="Edit text in region ${ri+1} of problem ${i+1}">Edit text</button>`:''}${p.regions.length>1?`<button data-action="region-up" data-region="${r.id}" aria-label="Move region ${ri+1} up" ${ri===0?'disabled':''}>↑</button><button data-action="region-down" data-region="${r.id}" aria-label="Move region ${ri+1} down" ${ri===p.regions.length-1?'disabled':''}>↓</button>`:''}<button data-action="remove-region" data-region="${r.id}" aria-label="Remove region ${ri+1} of problem ${i+1}">×</button></div></div></div>`).join('')}</div>
    <div class="problem-format-actions"><button class="button small" data-action="ai-format">Format with AI</button>${p.aiOriginal?'<button class="button subtle small" data-action="restore-original">Restore original</button>':''}</div>
    <div class="problem-controls"><label>${settings().spacing === 'compact' ? 'Writing space' : 'Minimum space'} (in)<input type="number" data-field="space" min="0" max="10" step="0.25" value="${+(p.space/72).toFixed(3)}"></label><label>Question size (%)<input type="number" data-field="scale" min="25" max="200" step="5" value="${p.scale}"></label><label class="wide">Oversized problem<select data-field="fit"><option value="flow"${p.fit==='flow'?' selected':''}>Continue onto next page</option><option value="shrink"${p.fit==='shrink'?' selected':''}>Fit to one page (shrink question)</option></select></label></div>
    <p class="scale-hint${p.scale<70?' small-print':''}">${p.scale<70?`${p.scale}% can make source text very small.`:'100% keeps the original print size.'}${p.scale!==100?' <button class="reset-scale" data-action="reset-scale">Reset to 100%</button>':''}</p>
    <label class="check-label"><input type="checkbox" data-field="pageBreak" ${p.pageBreak?'checked':''}> Start on a new page</label>${p.id===state.selected?'<p class="selected-hint">Selected · new regions can be appended to this problem.</p>':''}
  </li>`).join('');
  renderOverlay(); updateButtons();
}
async function addCurrent(mode) {
  if(!state.crop || !source()) return;
  const crop={...state.crop,rect:{...state.crop.rect}};
  await runBusy('Preparing a print-quality crop…',async()=>{
    const region=await cropRegion(source(),state.page,crop.rect,crop.regionId);
    if(mode==='update') {
      const p=state.problems.find(p=>p.id===crop.problemId); if(!p) throw new Error('The selected problem no longer exists.');
      const index=p.regions.findIndex(r=>r.id===crop.regionId); if(index<0) throw new Error('The selected region no longer exists.'); p.regions[index]=region;
    } else if(mode==='append') {
      if(!selected()) throw new Error('Select a problem card first.'); selected().regions.push(region);
    } else {
      const p=newProblem(region);state.problems.push(p);state.selected=p.id;
    }
    if(crop.suggestionId)state.suggestions=state.suggestions.filter(s=>s.id!==crop.suggestionId);
    state.crop=null;dirty();renderQueue();renderCropEditor();renderSuggestions();
    tell(mode==='append'?'Region appended. Its content will stay in the same problem.':mode==='update'?'Crop updated. Preview will use the new selection.':'Problem added. Adjust its writing space in the worksheet panel.');
  });
}
async function editRegion(problem, id) {
  const r=problem.regions.find(r=>r.id===id);if(!r?.sourceId)return;
  await runBusy('Opening selected region…',async()=>{
    const changed=state.sourceId!==r.sourceId||state.page!==r.page;
    state.sourceId=r.sourceId;state.page=r.page;state.selected=problem.id;
    if(changed)state.suggestions=[];
    state.crop={rect:{...r.rect},regionId:r.id,problemId:problem.id};
    renderSources();await showSource();renderQueue();
    $('#source-workspace').scrollIntoView({block:'nearest',behavior:'smooth'});
  });
}
function switchView(view) {
  state.view=view;$('#editor-view').hidden=view!=='edit';$('#preview-view').hidden=view!=='preview';
  for(const [id,active] of [['#edit-tab',view==='edit'],['#preview-tab',view==='preview']]){$(id).classList.toggle('active',active);$(id).setAttribute('aria-selected',String(active));}
}
async function ensurePreview() {
  if(!state.problems.length)throw new Error('Add at least one problem first.');
  if(state.preview?.revision===state.revision)return;
  const result=await createWorksheet(state.problems,settings());
  const container=document.createElement('div');const previewInfo=await renderPreview(result.bytes,container);
  if(previewInfo?.reducedResolution)result.layout.warnings.push({kind:'preview',message:'Preview images are reduced for this long worksheet. The exported PDF keeps the full crop resolution.'});
  presentPreview(result,container);
}
function presentPreview(result,container) {
  $('#preview-pages').replaceChildren(...container.childNodes);
  state.preview={...result,revision:state.revision};
  const {layout}=result;
  $('#preview-count').textContent=layout.pages.length;
  $('#preview-summary').innerHTML=`<strong>${state.problems.length}</strong> problem${state.problems.length===1?'':'s'} · <strong>${layout.pages.length}</strong> page${layout.pages.length===1?'':'s'}<br>${settings().paper==='letter'?'US Letter · 8.5 × 11 in':'A4 · 210 × 297 mm'}<br>${settings().margin/72} in margins · 300 dpi target<br>${settings().spacing === 'compact' ? 'Compact' : 'Balanced'} page spacing`;
  $('#preview-spacing-note').textContent = settings().spacing === 'compact'
    ? 'Print at 100% / Actual size. Each problem keeps exactly the writing height you entered.'
    : 'Print at 100% / Actual size. Writing space is a minimum; spare room is shared below whole problems. Pages with continuing problems keep the requested spacing.';
  const unique=[...new Set(layout.warnings.map(w=>w.message))];
  $('#layout-warnings').innerHTML=unique.map(w=>`<div class="warning">${escape(w)}</div>`).join('');
}
async function showPreview() {await runBusy('Building the final PDF preview…',async()=>{switchView('preview');await ensurePreview();});}
async function exportPDF() {
  await runBusy('Preparing the worksheet PDF…',async()=>{
    await ensurePreview();
    const blob=new Blob([state.preview.bytes],{type:'application/pdf'});const url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=($('#worksheet-title').value.trim()||'Math worksheet').replace(/[<>:"/\\|?*\x00-\x1f]/g,'-')+'.pdf';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    tell(`Exported ${state.preview.layout.pages.length} page${state.preview.layout.pages.length===1?'':'s'}. Print at 100% / Actual size.`);
  });
}

function aiControls(editor) {
  if(aiEditor!==editor)return;
  $('#ai-run').disabled=editor.busy||!editor.available||!editor.assets?.length;
  $('#ai-recheck').disabled=editor.busy||!editor.assets?.length||location.protocol!=='http:'||location.hostname!=='localhost';
  $('#ai-refresh').disabled=editor.busy||!editor.plan;
  $('#ai-add-block').disabled=editor.busy||!editor.plan||editor.plan.blocks.length>=24;
  $('#ai-blocks').inert=editor.busy;
  $('#ai-apply').disabled=editor.busy||!editor.draft||editor.dirty;
}
function aiOriginals(editor) {
  $('#ai-originals').innerHTML=(editor.assets||[]).map((asset,i)=>`<figure><div class="ai-source-image"><img src="${editor.images?.[i]?.dataUrl||asset.thumbnail}" alt="Original selection ${i+1}">${(editor.plan?.blocks||[]).map((b,j)=>b.source===i?`<div class="ai-source-box ${b.kind}" style="${rectStyle(b.rect)}"><span>${j+1} · ${b.kind==='text'?'Text':'Image'}</span></div>`:'').join('')}</div><figcaption>Selection ${i+1} · ${escape(asset.sourceName)}${asset.sourceId?` · page ${asset.page}`:''}</figcaption></figure>`).join('');
}
function aiBlocks(editor) {
  $('#ai-blocks').innerHTML=editor.plan.blocks.map((b,i)=>`<fieldset class="ai-block" data-index="${i}"><legend>Part ${i+1}</legend><div class="ai-block-tools"><label>Content<select data-ai-field="kind"><option value="text"${b.kind==='text'?' selected':''}>Reflowed text</option><option value="image"${b.kind==='image'?' selected':''}>Original image</option></select></label><label>Source<select data-ai-field="source">${editor.assets.map((_,j)=>`<option value="${j}"${b.source===j?' selected':''}>Selection ${j+1}</option>`).join('')}</select></label><button class="button small" data-ai-action="up" aria-label="Move part ${i+1} up" ${i===0?'disabled':''}>↑</button><button class="button small" data-ai-action="down" aria-label="Move part ${i+1} down" ${i===editor.plan.blocks.length-1?'disabled':''}>↓</button><button class="button small" data-ai-action="remove" aria-label="Remove part ${i+1}">Remove</button></div>${b.kind==='text'?`<label>Exact wording<textarea rows="4" data-ai-field="text" maxlength="6000">${escape(b.text)}</textarea></label>`:''}<div class="coordinates">${[['x','Left'],['y','Top'],['w','Width'],['h','Height']].map(([f,label])=>`<label>${label} %<input type="number" data-ai-field="${f}" value="${+(b.rect[f]*100).toFixed(4)}" min="0" max="100" step="0.1"></label>`).join('')}</div></fieldset>`).join('');
  $('#ai-adjustments').hidden=false;
  aiControls(editor);
}
function aiDirty(editor) {
  editor.dirty=true;editor.draft=null;editor.pdf=null;
  $('#ai-preview-pages').replaceChildren();
  $('#ai-review-status').textContent='Changes are not yet previewed. Choose Update preview before applying.';
  aiControls(editor);
}
async function checkAiStatus(editor) {
  const response=await fetch('/api/ai/status',{signal:AbortSignal.any([editor.controller.signal,AbortSignal.timeout(8000)])});
  if(!response.ok)throw new Error('The local AI helper is unavailable. Restart the app with npm start.');
  const status=await response.json();if(aiEditor!==editor)return;
  editor.available=status.available===true;
  $('#ai-status').textContent=editor.available?`Ready · ${status.model}. Ollama will process ${editor.assets.length} selected image${editor.assets.length===1?'':'s'} on this computer.`:(status.message||'Start Ollama and install the local vision model, then check again.');
  $('#ai-setup').hidden=editor.available;
}
async function openAiEditor(problem=null) {
  if(state.busy||aiEditor||(!problem&&(!state.crop||state.crop.regionId||!source())))return;
  const original=problem?(problem.aiOriginal||{...problem,regions:[...problem.regions]}):null;
  const editor={problemId:problem?.id,original,crop:state.crop?{...state.crop,rect:{...state.crop.rect}}:null,
    options:settings(),defaults:{...(problem||state.defaults)},assets:null,images:null,plan:null,draft:null,pdf:null,
    available:false,busy:true,dirty:true,controller:new AbortController()};
  aiEditor=editor;
  $('#ai-status').textContent='Preparing the original selection…';
  $('#ai-setup').hidden=true;$('#ai-results').hidden=true;$('#ai-adjustments').hidden=true;$('#ai-adjustments').open=false;
  for(const id of ['#ai-originals','#ai-preview-pages','#ai-blocks','#ai-warnings'])$(id).replaceChildren();
  $('#ai-usage').textContent='';$('#ai-review-status').textContent='';
  $('#ai-apply').textContent=problem?'Replace problem':'Add problem';
  $('#ai-run').textContent='Generate with AI';
  aiControls(editor);$('#ai-dialog').showModal();
  if(location.protocol!=='http:'||location.hostname!=='localhost') {
    editor.busy=false;$('#ai-status').textContent='AI formatting is available in the local app. Manual tools still work here.';$('#ai-setup').hidden=false;aiControls(editor);return;
  }
  const input=source(),pageNumber=state.page;
  try {
    if(original&&original.regions.length>6)throw new Error('AI can format up to six original regions together. Use fewer regions or keep this problem as manual crops.');
    editor.assets=original?[...original.regions]:[await cropRegion(input,pageNumber,editor.crop.rect)];
    if(aiEditor!==editor)return;
    editor.images=[];
    for(const asset of editor.assets){editor.images.push(await aiImage(asset));if(aiEditor!==editor)return;}
    aiOriginals(editor);
    await checkAiStatus(editor);
  } catch(error) {
    if(aiEditor!==editor)return;
    $('#ai-status').textContent=error.message||'Could not prepare the selection.';
    $('#ai-setup').hidden=true;
  } finally {editor.busy=false;aiControls(editor);}
}
async function aiBuildPreview(editor) {
  const plan=validateAiPlan(editor.plan,editor.assets.length);
  const width=(PAPER[editor.options.paper]||PAPER.letter)[0]-editor.options.margin*2;
  const regions=[];
  for(const block of plan.blocks) {
    if(aiEditor!==editor)return;
    const region=block.kind==='text'?await textRegion(block.text,width):await cropAssetRegion(editor.assets[block.source],block.rect);
    if(block.kind==='text')region.sourceName='AI-formatted text';
    regions.push(region);
  }
  if(aiEditor!==editor)return;
  const original=editor.original||{id:uid(),regions:[...editor.assets],...state.defaults};
  const draft={id:editor.problemId||original.id,regions,space:editor.defaults.space,pageBreak:editor.defaults.pageBreak,scale:100,fit:'flow',aiOriginal:original};
  const problems=editor.problemId?state.problems.map(p=>p.id===editor.problemId?draft:p):[...state.problems,draft];
  const result=await createWorksheet(problems,editor.options);
  const container=document.createElement('div');
  const previewInfo=await renderPreview(result.bytes,container);
  if(aiEditor!==editor)return;
  if(previewInfo?.reducedResolution)result.layout.warnings.push({kind:'preview',message:'Preview resolution was reduced. Export keeps the original crop resolution.'});
  editor.plan=plan;editor.draft=draft;editor.pdf=result;editor.dirty=false;
  $('#ai-preview-pages').replaceChildren(...container.childNodes);$('#ai-results').hidden=false;
  $('#ai-warnings').innerHTML=[...plan.warnings,...result.layout.warnings.map(w=>w.message)].map(w=>`<div class="warning">${escape(w)}</div>`).join('');
  $('#ai-review-status').textContent='Check the proposal against the original. Nothing in the worksheet changes until you apply it.';
  aiOriginals(editor);aiControls(editor);
}
$('#ai-format').addEventListener('click',()=>openAiEditor());
$('#ai-recheck').addEventListener('click',async()=>{
  const editor=aiEditor;if(!editor||editor.busy||!editor.assets?.length)return;
  editor.busy=true;editor.available=false;aiControls(editor);$('#ai-status').textContent='Checking the local Ollama model…';
  try {await checkAiStatus(editor);}
  catch(error){if(aiEditor===editor){$('#ai-status').textContent=error.message||'Could not reach the local helper.';$('#ai-setup').hidden=false;}}
  finally {editor.busy=false;aiControls(editor);}
});
for(const id of ['#ai-cancel','#ai-close'])$(id).addEventListener('click',()=>$('#ai-dialog').close());
$('#ai-dialog').addEventListener('close',()=>{aiEditor?.controller.abort();aiEditor=null;});
$('#ai-run').addEventListener('click',async()=>{
  const editor=aiEditor;if(!editor||editor.busy||!editor.available)return;
  editor.busy=true;aiDirty(editor);$('#ai-warnings').replaceChildren();
  $('#ai-status').textContent='Formatting on this computer… The first run can take several minutes while the model loads. You can cancel while it works.';
  $('#ai-review-status').textContent='';
  try {
    const response=await fetch('/api/ai/format',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:editor.images}),signal:AbortSignal.any([editor.controller.signal,AbortSignal.timeout(610000)])});
    const result=await response.json();
    if(aiEditor!==editor)return;
    if(!response.ok)throw new Error(result.error||'AI formatting failed. Try again or use manual crops.');
    editor.plan=validateAiPlan(result.plan,editor.assets.length);
    $('#ai-status').textContent=`Building the PDF proposal · ${result.model||'Ollama'}`;
    $('#ai-usage').textContent=Number.isFinite(result.usage?.inputTokens)&&Number.isFinite(result.usage?.outputTokens)
      ?`Local generation: ${result.usage.inputTokens.toLocaleString()} input tokens · ${result.usage.outputTokens.toLocaleString()} output tokens. No API charge.`:'';
    aiBlocks(editor);await aiBuildPreview(editor);
    if(aiEditor===editor){$('#ai-status').textContent='Proposal ready. Review it below.';$('#ai-run').textContent='Generate again';}
  } catch(error) {
    if(aiEditor!==editor)return;
    $('#ai-status').textContent=error.message||'AI formatting failed. Your original problem is unchanged.';
    $('#ai-review-status').textContent='Nothing was applied. Cancel to keep working manually, or try again.';
  } finally {editor.busy=false;aiControls(editor);}
});
$('#ai-blocks').addEventListener('input',e=>{
  const editor=aiEditor,field=e.target.dataset.aiField;if(!editor||editor.busy||!field)return;
  const block=editor.plan.blocks[Number(e.target.closest('.ai-block').dataset.index)];
  if(field==='text')block.text=e.target.value;
  else if(['x','y','w','h'].includes(field))block.rect[field]=e.target.value===''?NaN:Number(e.target.value)/100;
  else if(field==='source')block.source=Number(e.target.value);
  else if(field==='kind'){block.kind=e.target.value;block.text='';}
  aiDirty(editor);if(field==='kind')aiBlocks(editor);
});
$('#ai-blocks').addEventListener('click',e=>{
  const editor=aiEditor,button=e.target.closest('[data-ai-action]');if(!editor||editor.busy||!button)return;
  const i=Number(button.closest('.ai-block').dataset.index),blocks=editor.plan.blocks,action=button.dataset.aiAction;
  if(action==='remove')blocks.splice(i,1);
  else {const j=i+(action==='up'?-1:1);if(j>=0&&j<blocks.length)[blocks[i],blocks[j]]=[blocks[j],blocks[i]];}
  aiDirty(editor);aiBlocks(editor);
});
$('#ai-add-block').addEventListener('click',()=>{
  const editor=aiEditor;if(!editor||editor.busy||!editor.plan||editor.plan.blocks.length>=24)return;
  editor.plan.blocks.push({kind:'image',source:0,rect:{x:0,y:0,w:1,h:1},text:''});aiDirty(editor);aiBlocks(editor);
});
$('#ai-refresh').addEventListener('click',async()=>{
  const editor=aiEditor;if(!editor||editor.busy||!editor.plan)return;
  editor.busy=true;aiDirty(editor);$('#ai-review-status').textContent='Updating the PDF preview locally…';
  try {await aiBuildPreview(editor);}
  catch(error){if(aiEditor===editor)$('#ai-review-status').textContent=error.message||'Could not update the preview. Check your adjustments.';}
  finally {editor.busy=false;aiControls(editor);}
});
$('#ai-apply').addEventListener('click',()=>{
  const editor=aiEditor;if(!editor||editor.busy||editor.dirty||!editor.draft||!editor.pdf)return;
  if(editor.problemId){const i=state.problems.findIndex(p=>p.id===editor.problemId);if(i<0)return;state.problems[i]=editor.draft;}
  else state.problems.push(editor.draft);
  state.selected=editor.draft.id;
  if(!editor.problemId&&editor.crop?.suggestionId)state.suggestions=state.suggestions.filter(s=>s.id!==editor.crop.suggestionId);
  state.crop=null;dirty();renderQueue();renderCropEditor();renderSuggestions();
  presentPreview(editor.pdf,$('#ai-preview-pages'));
  $('#ai-dialog').close();
  tell('AI formatting applied. Writing space is preserved. Use Restore original on the problem card to undo it.');
});

for(const id of ['#upload-button','#choose-file-button'])$(id).addEventListener('click',()=>$('#file-input').click());
$('#file-input').addEventListener('change',async e=>{await addFiles([...e.target.files]);e.target.value='';});
for(const type of ['dragenter','dragover']) $('.source-panel').addEventListener(type,e=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();$('#empty-source').classList.add('drag-over');});
$('.source-panel').addEventListener('dragleave',()=>$('#empty-source').classList.remove('drag-over'));
$('.source-panel').addEventListener('drop',async e=>{e.preventDefault();$('#empty-source').classList.remove('drag-over');await addFiles([...e.dataTransfer.files]);});
$('#sample-button').addEventListener('click',async()=>{try{let data=globalThis.MARGIN_EMBEDDED?.sample;if(!data){const response=await fetch('/samples/sample.pdf');if(!response.ok)throw new Error('The sample PDF could not be loaded.');data=await response.arrayBuffer();}await addFiles([new File([data],'Sample problem set.pdf',{type:'application/pdf'})]);}catch(e){tell(e.message,true);}});
$('#source-select').addEventListener('change',async e=>{state.sourceId=e.target.value;state.page=1;state.crop=null;state.suggestions=[];await runBusy('Rendering page…',showSource);});
for(const [id,delta] of [['#prev-page',-1],['#next-page',1]])$(id).addEventListener('click',async()=>{if(state.busy)return;state.page=Math.max(1,Math.min(source().pages,state.page+delta));state.crop=null;state.suggestions=[];await runBusy('Rendering page…',showSource);});
$('#detect-button').addEventListener('click',async()=>{await runBusy('Finding numbered questions…',async()=>{const found=await suggestions(source(),state.page);state.suggestions=found.map(r=>({...r,id:uid()}));state.crop=null;renderOverlay();renderCropEditor();renderSuggestions();tell(found.length?`${found.length} suggestions found. Review the outlines before adding; headers, answers, and diagrams may need crop adjustments.`:'No reliable numbered text found. This may be a scan or an unnumbered page. Drag to select questions manually.');});});
$('#suggestion-bar').addEventListener('click',async e=>{
  if(e.target.id==='discard-suggestions'){state.suggestions=[];if(state.crop?.suggestionId)state.crop=null;renderSuggestions();renderOverlay();renderCropEditor();}
  if(e.target.id==='reject-suggestion'){state.suggestions=state.suggestions.filter(s=>s.id!==state.crop?.suggestionId);state.crop=null;renderSuggestions();renderOverlay();renderCropEditor();}
  if(e.target.id==='accept-all')await runBusy('Adding reviewed suggestions…',async()=>{
    // Commit each success so a bad region cannot discard earlier completed work.
    const pending=[...state.suggestions];let count=0;
    try{for(const s of pending){const r=await cropRegion(source(),state.page,s);const p=newProblem(r);state.problems.push(p);state.selected=p.id;state.suggestions=state.suggestions.filter(x=>x.id!==s.id);count++;}}
    finally{state.crop=null;if(count)dirty();renderQueue();renderOverlay();renderCropEditor();renderSuggestions();}
    tell(`${count} problems added. Review the preview before printing.`);
  });
});
$('#full-page-button').addEventListener('click',()=>setCrop({x:0,y:0,w:1,h:1}));
$('#clear-crop').addEventListener('click',()=>{state.crop=null;renderOverlay();renderCropEditor();renderSuggestions();});
for(const f of ['x','y','w','h'])$(`#crop-${f}`).addEventListener('change',e=>{if(!state.crop)return;state.crop.rect=normalizeRect({...state.crop.rect,[f]:Number(e.target.value)/100});syncSuggestion();renderOverlay();renderCropEditor();});
$('#add-problem').addEventListener('click',()=>addCurrent('new'));
$('#append-region').addEventListener('click',()=>addCurrent('append'));
$('#update-region').addEventListener('click',()=>addCurrent('update'));
let drag=null;
const point=e=>{const b=$('#crop-layer').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))};};
$('#crop-layer').addEventListener('pointerdown',e=>{
  if(state.busy||e.button!==0)return;e.preventDefault();
  $('#crop-layer').focus({preventScroll:true});
  const start=point(e), box=e.target.closest('.crop-box'), handle=e.target.dataset.handle;
  if(box?.dataset.region){const p=state.problems.find(p=>p.id===box.dataset.problem),r=p.regions.find(r=>r.id===box.dataset.region);state.selected=p.id;state.crop={rect:{...r.rect},regionId:r.id,problemId:p.id};renderQueue();}
  else if(box?.dataset.suggestion){const s=state.suggestions.find(s=>s.id===box.dataset.suggestion);state.crop={rect:{x:s.x,y:s.y,w:s.w,h:s.h},suggestionId:s.id};}
  else if(!box){state.crop={rect:{x:start.x,y:start.y,w:.005,h:.005}};}
  drag={start,rect:{...state.crop.rect},mode:handle?'resize':box?'move':'draw',handle,pointerId:e.pointerId};
  $('#crop-layer').setPointerCapture(e.pointerId);renderOverlay();renderCropEditor();renderSuggestions();
});
$('#crop-layer').addEventListener('pointermove',e=>{
  if(!drag||drag.pointerId!==e.pointerId)return;
  const p=point(e),r=drag.rect;let next;
  if(drag.mode==='draw')next={x:Math.min(p.x,drag.start.x),y:Math.min(p.y,drag.start.y),w:Math.abs(p.x-drag.start.x),h:Math.abs(p.y-drag.start.y)};
  else if(drag.mode==='move')next={...r,x:Math.max(0,Math.min(1-r.w,r.x+p.x-drag.start.x)),y:Math.max(0,Math.min(1-r.h,r.y+p.y-drag.start.y))};
  else{let left=r.x,right=r.x+r.w,top=r.y,bottom=r.y+r.h;if(drag.handle.includes('w'))left=Math.min(p.x,right-.005);if(drag.handle.includes('e'))right=Math.max(p.x,left+.005);if(drag.handle.includes('n'))top=Math.min(p.y,bottom-.005);if(drag.handle.includes('s'))bottom=Math.max(p.y,top+.005);next={x:left,y:top,w:right-left,h:bottom-top};}
  state.crop.rect=normalizeRect(next);syncSuggestion();renderOverlay();renderCropEditor();
});
const stopDrag=e=>{if(!drag||drag.pointerId!==e.pointerId)return;drag=null;if($('#crop-layer').hasPointerCapture(e.pointerId))$('#crop-layer').releasePointerCapture(e.pointerId);};
$('#crop-layer').addEventListener('pointerup',stopDrag);$('#crop-layer').addEventListener('pointercancel',stopDrag);
$('#problem-list').addEventListener('click',async e=>{
  const card=e.target.closest('.problem-card');if(!card||state.busy)return;
  const index=state.problems.findIndex(p=>p.id===card.dataset.id),p=state.problems[index];state.selected=p.id;
  const btn=e.target.closest('[data-action]');
  if(!btn){if(!e.target.matches('input,select,option,label'))renderQueue();else updateButtons();return;}
  const action=btn.dataset.action;
  if(action==='reset-scale'){p.scale=100;state.defaults.scale=100;rememberSettings();dirty();renderQueue();return;}
  if(action==='edit-region'){await editRegion(p,btn.dataset.region);return;}
  if(action==='edit-text'){const r=p.regions.find(r=>r.id===btn.dataset.region);if(typeof r?.text==='string'){renderQueue();openTextEditor({text:r.text,problemId:p.id,regionId:r.id});}return;}
  if(action==='ai-format'){renderQueue();await openAiEditor(p);return;}
  if(action==='restore-original'&&p.aiOriginal){state.problems[index]={...p.aiOriginal,regions:[...p.aiOriginal.regions]};state.crop=null;dirty();renderQueue();renderCropEditor();tell('Original problem and its settings restored.');return;}
  if(action==='up'||action==='down'){const j=index+(action==='up'?-1:1);if(j>=0&&j<state.problems.length)[state.problems[index],state.problems[j]]=[state.problems[j],state.problems[index]];}
  if(action==='remove')state.problems.splice(index,1);
  if(action==='remove-region'){p.regions=p.regions.filter(r=>r.id!==btn.dataset.region);if(!p.regions.length)state.problems.splice(index,1);}
  if(action==='region-up'||action==='region-down'){const i=p.regions.findIndex(r=>r.id===btn.dataset.region),j=i+(action==='region-up'?-1:1);if(j>=0&&j<p.regions.length)[p.regions[i],p.regions[j]]=[p.regions[j],p.regions[i]];}
  if(!selected())state.selected=state.problems[Math.min(index,state.problems.length-1)]?.id||null;
  if(state.crop?.regionId&&!state.problems.some(p=>p.regions.some(r=>r.id===state.crop.regionId)))state.crop=null;
  dirty();renderQueue();renderCropEditor();
});
$('#problem-list').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('.problem-card')){state.selected=e.target.dataset.id;renderQueue();}});
$('#problem-list').addEventListener('change',e=>{
  const field=e.target.dataset.field;if(!field)return;
  const p=state.problems.find(p=>p.id===e.target.closest('.problem-card').dataset.id);state.selected=p.id;
  if(field==='space')p.space=Math.max(0,Math.min(10,Number(e.target.value)||0))*72;
  if(field==='scale')p.scale=Math.max(25,Math.min(200,Number(e.target.value)||100));
  if(field==='fit')p.fit=e.target.value;
  if(field==='pageBreak')p.pageBreak=e.target.checked;
  state.defaults[field]=p[field];rememberSettings();
  dirty();renderQueue();
});
for(const id of ['#worksheet-title','#paper-size','#page-margin','#name-line','#question-alignment','#page-spacing','#number-problems'])$(id).addEventListener(id==='#worksheet-title'?'input':'change',()=>{rememberSettings();dirty();if(id==='#page-spacing')renderQueue();});
$('#reset-preferences').addEventListener('click',()=>{
  state.defaults={...DEFAULT_PROBLEM};applyWorksheetSettings(DEFAULT_SETTINGS);rememberSettings();dirty();renderQueue();
  tell('Saved settings reset. Existing problems keep their individual settings.');
});
function updateTextTarget() {
  const editing = !!textEditor?.regionId;
  const append = !editing && $('#text-target').value === 'append';
  const p = editing ? state.problems.find(p => p.id === textEditor.problemId) : selected();
  $('#add-text').textContent = editing ? 'Save text' : append ? 'Append text' : 'Add problem';
  $('#text-size-note').textContent = editing || append
    ? `Problem ${state.problems.indexOf(p) + 1} uses ${p?.scale || 100}% size. Its existing regions and writing space are kept.`
    : textEditor?.reflow ? 'New reflowed problems start at 100% size and wrap to the current printable width.'
      : `New problems use the saved ${state.defaults.scale}% size. Text wraps to the current printable width.`;
}
function openTextEditor(options = {}) {
  textEditor = { ...options };
  const editing = !!options.regionId;
  $('#text-heading').textContent = editing ? 'Edit text' : options.reflow ? 'Review selected text' : 'Paste a problem';
  $('#problem-text').value = options.text || '';
  $('#text-review-note').textContent = options.notice || (options.reflow
    ? 'Check the wording, reading order, and symbols before adding. Keep equations and diagrams as image crops.'
    : 'Plain text and line breaks use a regular font. Keep typeset equations and diagrams as image crops; LaTeX commands are not typeset.');
  $('#text-target-row').hidden = editing;
  $('#text-target option[value="append"]').disabled = !selected();
  $('#text-target').value = options.target === 'append' && selected() ? 'append' : 'new';
  updateTextTarget();
  $('#text-dialog').showModal();
  $('#problem-text').focus();
}
for(const id of ['#text-button','#text-button-2'])$(id).addEventListener('click',()=>openTextEditor());
$('#text-target').addEventListener('change',updateTextTarget);
$('#text-dialog').addEventListener('close',()=>{if(!$('#text-dialog').open)textEditor=null;});
$('#reflow-text').addEventListener('click',async()=>{
  if(!state.crop || state.crop.regionId || !source())return;
  const crop = { ...state.crop, rect: { ...state.crop.rect } };
  const input = source(), pageNumber = state.page;
  let result;
  const ok = await runBusy('Reading the selected text…',async()=>{result=await selectedText(input,pageNumber,crop.rect);});
  if(!ok)return;
  const notice = ['Review the wording, reading order, and symbols. Select only prose; keep equations and diagrams as image crops.', ...result.warnings].join(' ');
  openTextEditor({text:result.text,reflow:true,notice,crop});
});
$('#add-text').addEventListener('click',async()=>{
  if(state.busy)return;
  const text = $('#problem-text').value.trim();
  if(!text){$('#problem-text').focus();return;}
  if(text.length>6000){$('#text-review-note').textContent='Text is limited to 6,000 characters. Split it into smaller regions; nothing has been added.';return;}
  const editor = { ...textEditor, target: $('#text-target').value };
  const parent = editor.regionId ? state.problems.find(p=>p.id===editor.problemId)
    : editor.target==='append' ? selected() : null;
  if((editor.regionId || editor.target==='append')&&!parent)return;
  $('#text-dialog').close();
  const ok = await runBusy('Formatting problem text…',async()=>{
    const options = settings();
    const width = (PAPER[options.paper] || PAPER.letter)[0] - options.margin * 2;
    const r = await textRegion(text,width);
    if(editor.regionId){
      const index=parent.regions.findIndex(r=>r.id===editor.regionId);
      if(index<0)throw new Error('This text region no longer exists.');
      r.id=editor.regionId;r.sourceName=parent.regions[index].sourceName;
      parent.regions[index]=r;state.selected=parent.id;
    } else {
      if(editor.reflow)r.sourceName='Reflowed text';
      if(parent){parent.regions.push(r);state.selected=parent.id;}
      else {
        const p=newProblem(r);
        if(editor.reflow){p.scale=100;p.fit='flow';}
        state.problems.push(p);state.selected=p.id;
      }
      if(editor.crop){
        if(editor.crop.suggestionId)state.suggestions=state.suggestions.filter(s=>s.id!==editor.crop.suggestionId);
        state.crop=null;
      }
    }
    dirty();renderQueue();renderCropEditor();renderSuggestions();
    tell(editor.regionId ? 'Text updated. Check the print preview.' : editor.reflow
      ? 'Reviewed text added. Select the original equation or diagram and press Q to append it to this problem.'
      : parent ? 'Text appended to the selected problem.' : 'Text problem added. Plain text and Unicode symbols are preserved; LaTeX commands are not typeset.');
  });
  if(!ok)openTextEditor({...editor,text,notice:$('#notice').textContent});
});
$('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());$('#close-help').addEventListener('click',()=>$('#help-dialog').close());
for(const id of ['#preview-tab','#preview-button'])$(id).addEventListener('click',showPreview);
for(const id of ['#edit-tab','#back-to-edit'])$(id).addEventListener('click',()=>switchView('edit'));
$('#refresh-preview').addEventListener('click',()=>{state.preview=null;showPreview();});
for(const id of ['#export-top','#export-button'])$(id).addEventListener('click',exportPDF);
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.repeat||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||state.busy||drag||state.view!=='edit'||$('dialog[open]'))return;
  const target=e.target;
  if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'))return;
  if(!state.crop||state.crop.regionId||!source())return;
  const key=e.key.toLowerCase();
  if(key!=='p'&&key!=='q')return;
  if(key==='q'&&!selected())return;
  e.preventDefault();void addCurrent(key==='p'?'new':'append');
});
window.addEventListener('beforeunload',e=>{if(state.problems.length){e.preventDefault();e.returnValue='';}});
applyWorksheetSettings(preferences.worksheet);renderSources();renderQueue();rememberSettings();
