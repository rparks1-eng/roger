// Fixed recovery UI is served outside editable browser source. It needs no model.
export const recoveryHTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roger — restore app</title><link rel="stylesheet" href="/app-recovery.css">
<script type="module" src="/app-recovery.js"></script></head><body><main>
<p class="eyebrow">ROGER RECOVERY</p><h1>Restore the last app change.</h1>
<p>This control works independently of the app’s editable interface and your AI connection.</p>
<p id="status" role="status">Checking the saved rollback…</p>
<button id="undo" disabled>Undo last app change</button><a href="/">Open Roger</a>
<p class="hint">If source files changed afterward, Roger preserves them and asks you to resolve the conflict.</p>
</main></body></html>`;
export const recoveryCSS = `:root{font-family:system-ui,sans-serif;color:#183b2d;background:#e5eee8}body{margin:0;padding:8vh 24px}main{max-width:640px;margin:auto;padding:32px;border:1px solid #b6c8b9;border-radius:24px;background:#f4f5ed}h1{font-size:clamp(26px,5vw,40px);line-height:1.15}p{line-height:1.6}.eyebrow{font-size:12px;letter-spacing:.14em;font-weight:700}.hint{font-size:13px;color:#4c6254}button,a{display:inline-block;padding:13px 18px;margin:8px 10px 8px 0;border-radius:12px}button{font:inherit;color:white;background:#24573d;border:0;cursor:pointer}button:disabled{opacity:.45;cursor:default}a{color:#24573d}`;
export const recoveryJS = `const status=document.getElementById('status');
const undo=document.getElementById('undo');let csrf='';
async function request(url,body){const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-Reader-CSRF':csrf}:{},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.error||'Recovery failed.');return result;}
async function load(){try{csrf=(await request('/api/session')).csrf;const state=await request('/api/app-changes');undo.disabled=!state.canUndo;status.textContent=state.canUndo?'A saved app change can be restored.':'No saved app change to undo.';}catch(error){status.textContent=error.message;}}
undo.addEventListener('click',async()=>{undo.disabled=true;try{await request('/api/app-changes/undo',{});status.textContent='Previous source restored. Open Roger to load it.';}catch(error){status.textContent=error.message;undo.disabled=false;}});void load();`;
