/** Single-page review UI. Served by the local review server; also embeddable in the desktop shell's webview. */
export function reviewPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>VivahLens review</title>
<style>
  body{font:14px system-ui,sans-serif;margin:0;background:#16181c;color:#e8e8ea}
  header{position:sticky;top:0;background:#1f2228;padding:10px 16px;display:flex;gap:12px;align-items:center;z-index:2}
  header h1{font-size:16px;margin:0;flex:1} button{padding:6px 12px;border-radius:6px;border:0;background:#4c7cf3;color:#fff;cursor:pointer}
  button.secondary{background:#3a3f4a} main{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;padding:16px}
  .card{background:#1f2228;border-radius:8px;overflow:hidden} .card.done{opacity:.55}
  .img{height:220px;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .img img{max-width:100%;max-height:100%}
  .meta{padding:8px 10px;display:flex;justify-content:space-between;gap:8px}
  .badge{font-size:11px;padding:2px 6px;border-radius:10px;background:#3a3f4a}
  .sliders{padding:0 10px 10px;display:grid;grid-template-columns:90px 1fr 48px;gap:4px 8px;align-items:center;font-size:12px}
  .note{color:#f0b429;font-size:12px;padding:0 10px 8px} #status{font-size:13px}
</style></head><body>
<header><h1 id="title">VivahLens review</h1><span id="status"></span>
<button class="secondary" id="all">Approve all</button><button id="submit">Submit decisions</button></header>
<main id="grid"></main>
<script>
const TOKEN=${JSON.stringify(token).replace(/</g, "\\u003c")};
const FIELDS=[["exposure",-5,5,0.05],["contrast",-100,100,1],["highlights",-100,100,1],["shadows",-100,100,1],
 ["whites",-100,100,1],["blacks",-100,100,1],["vibrance",-100,100,1],["saturation",-100,100,1],["tempK",2000,12000,50]];
const q=p=>p+(p.includes("?")?"&":"?")+"t="+encodeURIComponent(TOKEN);
const get=(a,k)=>k==="tempK"?(a.whiteBalance||{}).tempK:a[k];
const set=(a,k,v)=>{if(k==="tempK"){a.whiteBalance=Object.assign({},a.whiteBalance,{tempK:v})}else{a[k]=v}};
const state={items:[],approved:new Set(),edited:{}};
function filterFor(a){const e=a.exposure||0,c=a.contrast||0,s=a.saturation||0;
 return "brightness("+Math.pow(2,e).toFixed(3)+") contrast("+(1+c/100).toFixed(2)+") saturate("+(1+s/100).toFixed(2)+")"}
function card(it){
  const el=document.createElement("div");el.className="card"+(it.state==="review"?"":" done");
  const box=document.createElement("div");box.className="img";
  const img=document.createElement("img");img.src=q("/api/preview/"+encodeURIComponent(it.id));img.alt=it.id;box.append(img);
  const meta=document.createElement("div");meta.className="meta";
  const name=document.createElement("span");name.textContent=it.id;
  const badge=document.createElement("span");badge.className="badge";badge.textContent=it.state;meta.append(name,badge);
  el.append(box,meta);
  if(it.unsupported&&it.unsupported.length){const n=document.createElement("div");n.className="note";
    n.textContent="Adapter ignores: "+it.unsupported.join(", ");el.append(n)}
  if(it.outlierFields&&it.outlierFields.length){const n=document.createElement("div");n.className="note";
    n.textContent="Differs from the rest of the album: "+it.outlierFields.join(", ");el.append(n)}
  if(it.seenBefore){const n=document.createElement("div");n.className="note";
    n.textContent="Already processed in job "+it.seenBefore;el.append(n)}
  if(it.state!=="review"){if(it.errorMessage){const n=document.createElement("div");n.className="note";n.textContent=it.errorMessage;el.append(n)}return el}
  const adj=JSON.parse(JSON.stringify(it.recipe.adjustments));
  const grid=document.createElement("div");grid.className="sliders";
  for(const [k,min,max,step] of FIELDS){
    const cur=get(adj,k);const label=document.createElement("label");label.textContent=k;
    const input=document.createElement("input");input.type="range";input.min=min;input.max=max;input.step=step;
    input.value=cur===undefined?(k==="tempK"?5500:0):cur;
    const out=document.createElement("span");out.textContent=cur===undefined?"–":cur;
    input.oninput=()=>{const v=Number(input.value);set(adj,k,v);out.textContent=v;img.style.filter=filterFor(adj);
      state.edited[it.id]={version:"1.0",assetType:"photo",sourceStyleProfileId:it.recipe.sourceStyleProfileId,adjustments:adj}};
    grid.append(label,input,out);
  }
  img.style.filter=filterFor(adj);
  const ok=document.createElement("label");ok.style.gridColumn="1 / -1";
  const cb=document.createElement("input");cb.type="checkbox";cb.checked=state.approved.has(it.id);
  cb.onchange=()=>cb.checked?state.approved.add(it.id):state.approved.delete(it.id);
  ok.append(cb," Approve (preview colours are an approximation)");
  el.append(grid,ok);return el;
}
async function load(){
  const r=await fetch(q("/api/items"));const data=await r.json();state.items=data.items;
  document.getElementById("title").textContent="Review: "+data.job+" ("+data.adapter+")";
  const grid=document.getElementById("grid");grid.replaceChildren(...data.items.map(card));
  document.getElementById("status").textContent=data.items.filter(i=>i.state==="review").length+" awaiting review";
}
document.getElementById("all").onclick=()=>{state.items.filter(i=>i.state==="review").forEach(i=>state.approved.add(i.id));
  document.querySelectorAll("input[type=checkbox]").forEach(c=>c.checked=true)};
document.getElementById("submit").onclick=async()=>{
  const body={approve:[...state.approved],overrides:state.edited};
  const r=await fetch(q("/api/decide"),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const res=await r.json();
  document.getElementById("status").textContent=r.ok?("Done: "+res.exported+" exported, "+res.approved+" approved, "+res.failed+" failed"):("Error: "+res.error);
  state.approved.clear();state.edited={};await load();
};
load();
</script></body></html>`;
}
