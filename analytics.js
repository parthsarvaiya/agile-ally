'use strict';
/* ════════════════════════════════════════════════════════════════
   FLOW ANALYTICS  -  Phase 1
   Checkpoint 1A: data foundation (item model, CSV + Jira ingest,
                  settings spine, date/period utilities, preview)
   Checkpoint 1B: Monte Carlo forecasting  (added next)

   Relies on globals from index.html: at(), q, esc, showToast, parseCSV.
   Owns its own storage key `hudl_flow` so it follows team switching
   without touching the existing persist() pipeline.
   ════════════════════════════════════════════════════════════════ */

// ── STATE ──────────────────────────────────────────────────────
const FLOW_DEFAULTS = {
  periodCalc:'work',      // 'work' | 'calendar'
  timeSpan:'biweekly',    // weekly | biweekly | monthly | quarterly | yearly
  dateFormat:'auto',      // auto | dmy | mdy
  sprintStart:'',         // anchor date (YYYY-MM-DD) for week/biweek alignment
  sprintLength:2,         // weeks (1-4) - used with biweekly
  sameDayValue:1          // created==completed counts as this many days
};
let flowStore = { settings:{...FLOW_DEFAULTS}, teams:{} };
let flowCsv = { headers:[], rows:[] };       // staged CSV awaiting mapping
let flowJira = [];                            // fetched raw Jira issues
let flowSub = 'flow';                         // 'flow' | 'sprint'
let flowInput = 'csv';                        // 'csv' | 'jira'
let flowDetectedFmt = null;                   // auto-detected date format
let flowSaveTimer = null;
// Monte Carlo controls
let flowMcMode = 'howmany';                   // 'howmany' | 'whendone'
let flowMcMetric = 'count';                   // 'count' | 'points'
let flowMcN = 6;                              // periods ahead (How Many)
let flowMcTarget = 100;                       // backlog size (When Done)
let flowMcSplit = 0;                          // scope-creep % (When Done)
let flowMcManual = null;                      // null = auto samples, else number[]
const FLOW_TRIALS = 10000;
// Time-metrics controls (Phase 2)
let flowSlePct = 85;                          // SLE percentile
let flowDurBucket = 5;                        // histogram bucket width (days)
// Scatterplot zoom / drag state (Phase 2B)
let flowZoom = {lead:null, cycle:null};       // null = full range, else {min,max} in ms
let flowScatterGeo = {};                      // per-scatter geometry for coord mapping
let flowDrag = null;                          // {which, x0} during a drag
// WIP & aging controls (V3-3)
let flowBacklogThr = 30;                       // backlog staleness threshold (days)
let flowCfdShowWip = true;                     // show the in-progress band on the CFD
// Data table controls (V3-6)
let flowTblSearch = '';
let flowTblSort = {col:'completed', dir:'desc'};
// Per-chart controls: style (line/bar), labels, trend type (V3-6 addendum)
let flowChartCtl = {};   // { [chartId]: {style, labels, trend} }

// ── STORAGE ────────────────────────────────────────────────────
function flowPersist(){
  clearTimeout(flowSaveTimer);
  flowSaveTimer = setTimeout(()=>{
    try{ localStorage.setItem('hudl_flow', JSON.stringify(flowStore)); }catch(e){}
    if(typeof autoBackupWrite==='function') autoBackupWrite();
  }, 250);
}
function flowLoad(){
  try{
    const d = JSON.parse(localStorage.getItem('hudl_flow')||'null');
    if(d){
      flowStore.settings = {...FLOW_DEFAULTS, ...(d.settings||{})};
      flowStore.teams = d.teams || {};
    }
  }catch(e){}
}
// All item-level tickets for the active team (unfiltered). Used by Sprint Insights, which needs every sprint.
function flowAllItems(){
  const t = (typeof at==='function') ? at() : null;
  if(!t) return [];
  return (flowStore.teams[t.id] && flowStore.teams[t.id].items) || [];
}
// Flow Metrics tab scope: '' = all sprints, else a sprint name. Filters what the Flow Metrics charts/KPIs see.
let flowScope='';
function flowSetScope(v){ flowScope=v||''; if(typeof renderFlow==='function') renderFlow(); }
// Items the Flow Metrics tab computes on, narrowed to flowScope when set.
function flowItems(){
  const all=flowAllItems();
  return flowScope ? all.filter(i=>i.sprint===flowScope) : all;
}
function flowSetItems(arr){
  const t = at(); if(!t) return;
  if(!flowStore.teams[t.id]) flowStore.teams[t.id] = {};
  flowStore.teams[t.id].items = arr;
  flowPersist();
}
function flowSettings(){ return flowStore.settings; }

// ── Shared cache via the built-in Persistence API (/api/vibes/{owner}/{vibe}/data) ──
// Lets the dashboard load instantly from the last Jira pull, and lets a teammate who
// has never fetched still see data. Same-origin, no token, no install.
function pDataBase(){ const m=(location.pathname||'').match(/\/v\/([^\/]+)\/([^\/]+)/); return m ? '/api/vibes/'+m[1]+'/'+m[2]+'/data' : null; }
async function pGet(key){ const b=pDataBase(); if(!b) return null; try{ const r=await fetch(b+'/'+key); if(!r.ok) return null; const d=await r.json(); return (d && 'value' in d) ? d.value : null; }catch(e){ return null; } }
async function pPut(key,value){ const b=pDataBase(); if(!b) return false; try{ const r=await fetch(b+'/'+key,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})}); return r.ok; }catch(e){ return false; } }
function flowCacheKey(){ const t=(typeof at==='function')?at():null; const id=(t&&t.id)||'default'; return 'jiracache.flow.'+String(id).replace(/[^a-zA-Z0-9._:-]/g,'-'); }
async function flowCacheSave(items, jql){
  const t=at(); if(!t) return;
  const savedAt=new Date().toISOString();
  const payload={savedAt, jql:jql||'', items};
  const str=JSON.stringify(payload);
  if(str.length>380000){ if(typeof showToast==='function') showToast('Loaded, but too large to cache ('+Math.round(str.length/1024)+'KB)','a'); return; }
  const ok=await pPut(flowCacheKey(), payload);
  if(ok){ if(!flowStore.teams[t.id]) flowStore.teams[t.id]={}; flowStore.teams[t.id].jiraSyncedAt=savedAt; flowStore.teams[t.id].fromCache=false; flowPersist(); flowRenderSyncNote(); }
}
const flowHydrated=new Set();
async function flowMaybeHydrate(){
  const t=at(); if(!t || flowHydrated.has(t.id)) return;
  flowHydrated.add(t.id);
  if(flowAllItems().length) return;                 // this browser already has data
  const payload=await pGet(flowCacheKey());
  if(payload && Array.isArray(payload.items) && payload.items.length){
    if(!flowStore.teams[t.id]) flowStore.teams[t.id]={};
    flowStore.teams[t.id].items=payload.items;
    flowStore.teams[t.id].jiraSyncedAt=payload.savedAt||'';
    flowStore.teams[t.id].fromCache=true;
    flowPersist();
    if(typeof renderFlow==='function') renderFlow();
  }
}
function flowSyncLabel(){
  const t=at(); const iso=t&&flowStore.teams[t.id]&&flowStore.teams[t.id].jiraSyncedAt;
  if(!iso) return ''; const d=new Date(iso); if(isNaN(d)) return '';
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[d.getMonth()]+' '+d.getDate()+', '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function flowRenderSyncNote(){
  const el=(typeof q==='function')?q('#fa-jira-sync'):null; if(!el) return;
  const lbl=flowSyncLabel(); const t=at();
  const cached=t&&flowStore.teams[t.id]&&flowStore.teams[t.id].fromCache;
  el.innerHTML = lbl ? ('Last Jira sync: <strong>'+esc(lbl)+'</strong>'+(cached?' (loaded from the shared cache; this device has not fetched yet)':'')) : '';
}

// ── DATE PARSING ───────────────────────────────────────────────
const FLOW_MONTHS = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function flowParseISO(s){
  if(!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? new Date(+m[1], +m[2]-1, +m[3]) : null;
}
// Parse one date cell; hint is 'auto'|'dmy'|'mdy'. Returns Date or null.
function flowParseDate(raw, hint){
  if(raw==null) return null;
  let s = String(raw).trim();
  if(!s) return null;
  // ISO (with optional time)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  // DD/Mon/YY[YY]  e.g. 12/Jan/2026, 3-Feb-26
  m = s.match(/^(\d{1,2})[\/\-\s]([A-Za-z]{3,})[\/\-\s](\d{2,4})/);
  if(m){
    const mo = FLOW_MONTHS[m[2].slice(0,3).toLowerCase()];
    if(mo!=null){ let y=+m[3]; if(y<100) y+=2000; return new Date(y, mo, +m[1]); }
  }
  // numeric a/b/y  (slash or dash)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if(m){
    let a=+m[1], b=+m[2], y=+m[3]; if(y<100) y+=2000;
    let fmt = (hint && hint!=='auto') ? hint : (flowDetectedFmt || 'mdy');
    let day, mon;
    if(fmt==='dmy'){ day=a; mon=b; } else { mon=a; day=b; }
    if(mon>=1 && mon<=12 && day>=1 && day<=31) return new Date(y, mon-1, day);
  }
  // last resort
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
// Scan numeric date strings to decide day-first vs month-first. null = ambiguous.
function flowDetectFormat(values){
  let dayFirst=false, monthFirst=false;
  for(const v of values){
    const m = String(v||'').match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-]\d{2,4}/);
    if(!m) continue;
    const a=+m[1], b=+m[2];
    if(a>12) dayFirst=true;
    if(b>12) monthFirst=true;
  }
  if(dayFirst && !monthFirst) return 'dmy';
  if(monthFirst && !dayFirst) return 'mdy';
  return null;
}
function flowStartOfDay(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function flowMondayOf(d){
  const x = flowStartOfDay(d); const dow = (x.getDay()+6)%7; // Mon=0
  x.setDate(x.getDate()-dow); return x;
}
function flowFmtDate(d){
  const mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate()+'-'+mo[d.getMonth()]+'-'+d.getFullYear();
}

// ── PERIOD BUCKETING ───────────────────────────────────────────
// Returns {key, label, start:Date} for a date under the current time span.
function flowPeriodOf(date, st){
  st = st || flowSettings();
  const ts = st.timeSpan;
  if(ts==='monthly'){
    const k = date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    return {key:k, label:flowFmtDate(start).replace(/^\d+-/,''), start};
  }
  if(ts==='quarterly'){
    const qq = Math.floor(date.getMonth()/3)+1;
    return {key:date.getFullYear()+'-Q'+qq, label:date.getFullYear()+' Q'+qq, start:new Date(date.getFullYear(),(qq-1)*3,1)};
  }
  if(ts==='yearly'){
    return {key:''+date.getFullYear(), label:''+date.getFullYear(), start:new Date(date.getFullYear(),0,1)};
  }
  // weekly / biweekly - anchored to sprintStart (or Monday of the date)
  const lenWeeks = (ts==='biweekly') ? (st.sprintLength||2) : 1;
  const anchor = st.sprintStart ? flowStartOfDay(flowParseISO(st.sprintStart)||date) : flowMondayOf(date);
  const MS = 86400000, periodDays = lenWeeks*7;
  const diff = Math.floor((flowStartOfDay(date) - anchor)/MS);
  const idx = Math.floor(diff/periodDays);
  const start = new Date(anchor.getTime() + idx*periodDays*MS);
  return {key:'P'+idx+'@'+anchor.getTime(), label:flowFmtDate(start), start};
}

// ── ITEM MODEL ─────────────────────────────────────────────────
// item = { id, type, status, created, started, completed, points, sprint }
// dates are stored as ISO strings (YYYY-MM-DD) or '' ; numbers as numbers.
function flowNormType(t){
  const s=(t||'').toLowerCase();
  if(s.includes('bug')||s.includes('defect')) return 'Bug';
  if(s.includes('story')) return 'Story';
  if(s.includes('task')||s.includes('sub-task')||s.includes('subtask')) return 'Task';
  if(s.includes('epic')) return 'Epic';
  return t || 'Other';
}
function flowTypeClass(t){
  const s=(t||'').toLowerCase();
  if(s==='bug') return 'bug';
  if(s==='story') return 'story';
  if(s==='task') return 'task';
  return 'other';
}
function flowStatusClass(category){
  const s=(category||'').toLowerCase();
  if(s.includes('done')||s.includes('complete')||s.includes('closed')||s.includes('resolved')) return 'done';
  if(s.includes('progress')||s.includes('review')||s.includes('doing')) return 'progress';
  return 'todo';
}
function flowToISO(d){ return d ? d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') : ''; }

// ════════════════════════════════════════════════════════════════
// BENCHMARKS + 2-COLUMN CHART ROW  -  V3-1
// Thresholds default to the industry table but are editable per team.
// dir 'lower' = smaller is better; 'higher' = larger is better.
// t = [excellent boundary, good boundary, needs-attention boundary]
// ════════════════════════════════════════════════════════════════
const FLOW_BENCH = {
  medianLead:  {label:'Median lead time',            unit:'d', dir:'lower',  t:[7,14,30]},
  medianCycle: {label:'Median cycle time',           unit:'d', dir:'lower',  t:[5,10,20]},
  ltCov:       {label:'Lead time CoV',               unit:'%', dir:'lower',  t:[30,50,75]},
  tpCov:       {label:'Throughput stability (CoV)',  unit:'%', dir:'lower',  t:[20,35,60]},
  predRatio:   {label:'Predictability (P85/P50)',    unit:'x', dir:'lower',  t:[1.5,2,3]},
  flowEff:     {label:'Flow efficiency',             unit:'%', dir:'higher', t:[40,25,15]},
  sleAttain:   {label:'SLE attainment',              unit:'%', dir:'higher', t:[90,75,50]},
  defectRate:  {label:'Defect rate',                 unit:'%', dir:'lower',  t:[5,10,20]},
  wipPerPerson:{label:'WIP per person',              unit:'',  dir:'lower',  t:[3,5,8]}
};
const FLOW_TIERS = {
  excellent:{label:'Excellent',       col:'var(--green)', bg:'var(--green-bg)', bd:'var(--green-bd)'},
  good:     {label:'Good',            col:'var(--sky)',   bg:'var(--sky-bg)',   bd:'var(--sky-bd)'},
  attention:{label:'Needs attention', col:'var(--amber)', bg:'var(--amber-bg)', bd:'var(--amber-bd)'},
  critical: {label:'Critical',        col:'var(--red)',   bg:'var(--red-bg)',   bd:'var(--red-bd)'}
};
function flowBench(){
  const ov=(flowSettings().bench)||{}, out={};
  for(const k in FLOW_BENCH){ out[k]={...FLOW_BENCH[k], t:(ov[k]&&ov[k].length===3)?ov[k].slice():FLOW_BENCH[k].t.slice()}; }
  return out;
}
function flowClassify(key, value){
  const b=flowBench()[key]; if(!b||value==null||isNaN(value)) return null;
  const [t0,t1,t2]=b.t; let tier;
  if(b.dir==='lower') tier = value<=t0?'excellent':value<=t1?'good':value<=t2?'attention':'critical';
  else                tier = value>=t0?'excellent':value>=t1?'good':value>=t2?'attention':'critical';
  return {tier, ...FLOW_TIERS[tier], bench:b};
}
function flowReach(key){
  const b=flowBench()[key]; if(!b) return ['',''];
  const u=b.unit, w=b.dir==='lower'?'or fewer':'or more';
  return ['Good: '+b.t[1]+u+' '+w, 'Excellent: '+b.t[0]+u+' '+w];
}
function flowGap(key, value){
  const b=flowBench()[key]; if(!b||value==null) return '';
  const [t0,t1]=b.t, u=b.unit, r=v=>Math.round(v*10)/10;
  if(b.dir==='lower'){
    if(value<=t0) return 'Beating the Excellent threshold ('+t0+u+').';
    if(value<=t1) return 'Within Good; '+r(value-t0)+u+' from Excellent.';
    return r(value-t1)+u+' above the Good threshold ('+t1+u+').';
  }
  if(value>=t0) return 'Beating the Excellent threshold ('+t0+u+').';
  if(value>=t1) return 'Within Good; '+r(t0-value)+u+' from Excellent.';
  return r(t1-value)+u+' below the Good threshold ('+t1+u+').';
}
const FLOW_METRIC_INFO = {
  medianLead:{measures:'How long work waits from request to delivery (created to done).',
    why:'It is what a stakeholder experiences as "how long it takes".',
    healthy:'Short and consistent, most items well under two weeks.',
    unhealthy:'Long or highly variable, with a fat tail of aged items.',
    redflags:'A rising median, or a widening gap between median and P85.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  medianCycle:{measures:'Active work time from when the team starts an item to done.',
    why:'It isolates execution speed from queue and wait time.',
    healthy:'Short relative to lead time and stable sprint to sprint.',
    unhealthy:'Creeping up, or nearly equal to lead time (no visibility into waiting).',
    redflags:'Cycle time climbing while throughput stays flat.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  tpCov:{measures:'How many items the team completes each period, and how steady that is.',
    why:'Stable throughput is the raw material for reliable forecasting.',
    healthy:'A flat or rising line with low period-to-period swing.',
    unhealthy:'Big spikes and troughs (high CoV) that make averages meaningless.',
    redflags:'Throughput falling while work-in-progress climbs.',
    ref:'Vacanti, When Will It Be Done?'},
  flowEff:{measures:'The share of total lead time an item spends actively worked versus waiting.',
    why:'Most delivery delay is queue time, not work time; this exposes it.',
    healthy:'Trending up; most teams live in the 15-40% range.',
    unhealthy:'Single digits, meaning items sit idle in queues and hand-offs.',
    redflags:'Efficiency dropping while cycle time rises.',
    ref:'Anderson, Kanban'},
  ltCov:{measures:'Coefficient of variation of lead time (spread relative to the mean).',
    why:'It is the cleanest single number for predictability.',
    healthy:'Under 50%, and stable or falling over time.',
    unhealthy:'Above 75%, meaning delivery time is close to a coin toss.',
    redflags:'CoV spiking in a period, signalling a process change or mixed work.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  defectRate:{measures:'Bugs as a share of all completed work per period.',
    why:'It shows whether quality is keeping pace with delivery speed.',
    healthy:'Low and stable, ideally under 10% of throughput.',
    unhealthy:'Rising defect share crowding out feature work.',
    redflags:'Defect rate climbing right after a delivery-speed push.',
    ref:'Forsgren, Accelerate'},
  netFlow:{measures:'Items completed minus items created each period.',
    why:'It tells you whether the backlog is shrinking or quietly growing.',
    healthy:'Hovering around zero or positive over a window.',
    unhealthy:'Persistently negative - intake outpaces delivery.',
    redflags:'Several negative periods in a row.',
    ref:'Anderson, Kanban'},
  workType:{measures:'The mix of completed work by type over time.',
    why:'It shows how effort splits between features, bugs, and upkeep.',
    healthy:'A deliberate, stable mix that matches strategy.',
    unhealthy:'Bug or unplanned share silently taking over.',
    redflags:'Feature share shrinking period over period.',
    ref:'Anderson, Kanban'},
  leadHist:{measures:'How completed items distribute across lead-time buckets.',
    why:'The shape reveals predictability that an average hides.',
    healthy:'A tight cluster with a short right tail.',
    unhealthy:'A long right tail of slow items, or two separate humps.',
    redflags:'Items scattered far past the SLE marker.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  cycleHist:{measures:'How completed items distribute across cycle-time buckets.',
    why:'Shows whether active work time is consistent or has a long tail.',
    healthy:'A tight cluster near the median.',
    unhealthy:'A wide spread or outliers that stalled in progress.',
    redflags:'A growing tail beyond P85.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  ltScatter:{measures:'Every completed item plotted by finish date and lead time.',
    why:'It surfaces outliers, clusters, and trends a summary stat cannot.',
    healthy:'Most dots below the P85 line with few stragglers.',
    unhealthy:'Frequent dots far above P85, or an upward drift over time.',
    redflags:'A rising band of dots in recent dates.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  ctScatter:{measures:'Every completed item plotted by finish date and cycle time.',
    why:'It pinpoints items that got stuck once work began.',
    healthy:'A stable band below P85.',
    unhealthy:'High outliers indicating blocked or abandoned-then-resumed work.',
    redflags:'Cycle-time outliers clustering in recent sprints.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  cycVsPts:{measures:'Each completed item plotted by its story-point estimate (x) against its actual cycle time (y), with the average cycle time per estimate.',
    why:'It shows whether story points actually predict how long work takes. In many teams the link is weak, which is a case for forecasting from throughput and cycle time rather than from estimates.',
    healthy:'A clear upward trend and tight spread means estimates track real effort.',
    unhealthy:'A flat or scattered cloud means points and time are barely related.',
    redflags:'Large items that finish fast, or small items that drag on for weeks.',
    ref:'Vacanti, When Will It Be Done?'},
  sle:{measures:'The lead time within which a chosen share of items complete.',
    why:'It is the honest, data-backed delivery promise to give stakeholders.',
    healthy:'A short SLE at the 85th percentile that holds steady.',
    unhealthy:'A long SLE, or one that keeps slipping period to period.',
    redflags:'Actual attainment falling below the committed percentile.',
    ref:'Vacanti, When Will It Be Done?'},
  cfd:{measures:'Cumulative created, in-progress, and done items over time.',
    why:'The vertical gap between bands is your work-in-progress; its width is delay.',
    healthy:'Bands rising in parallel with a narrow, steady in-progress gap.',
    unhealthy:'A widening in-progress band, meaning work piles up faster than it finishes.',
    redflags:'The Done band flattening while Created keeps climbing.',
    ref:'Anderson, Kanban'},
  wipTrend:{measures:'The count of started-but-not-done items over time.',
    why:'By Little’s Law, more WIP means longer cycle time; less WIP flows faster.',
    healthy:'Flat and near your Little’s Law estimate.',
    unhealthy:'Climbing WIP, usually from starting more than you finish.',
    redflags:'WIP rising while throughput is flat or falling.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'},
  wipAging:{measures:'How long each in-progress item has been open, versus your cycle-time percentiles.',
    why:'Aging items are the ones about to breach your SLE; catch them before they finish late.',
    healthy:'Most items below the P50 line, none in the red past P85.',
    unhealthy:'Items sitting well beyond P85 with no movement.',
    redflags:'The same items aging in the red zone across several days.',
    ref:'Vacanti, When Will It Be Done?'},
  backlogAging:{measures:'How long never-started items have sat in the backlog.',
    why:'Stale tickets clutter planning and often should be closed or re-scoped.',
    healthy:'A backlog that turns over, few items past the stale threshold.',
    unhealthy:'A pile of very old items no one intends to start.',
    redflags:'Age climbing on items repeatedly carried across sprints.',
    ref:'Anderson, Kanban'},
  bottleneck:{measures:'Where open work accumulates: waiting to start (queued) vs started but not done.',
    why:'It points to the constraint - intake or delivery - so you fix the right stage.',
    healthy:'Both bands thin and steady; work moves through without pooling.',
    unhealthy:'One band widening fast, meaning work enters a stage faster than it leaves.',
    redflags:'The in-progress band growing while throughput is flat (delivery bottleneck).',
    ref:'Goldratt, The Goal; Anderson, Kanban'},
  sleAttain:{measures:'The share of items each period that finished within your SLE.',
    why:'It tracks whether your delivery promise actually holds over time.',
    healthy:'At or above your committed percentile (e.g. 85%) most periods.',
    unhealthy:'Attainment slipping below the commitment line period after period.',
    redflags:'A downward trend in attainment even if the average still looks fine.',
    ref:'Vacanti, When Will It Be Done?'},
  distShape:{measures:'The shape of the lead-time distribution (a smoothed density curve).',
    why:'A single average hides mixed work; two peaks mean two different processes.',
    healthy:'One clear peak - a single, representative typical lead time.',
    unhealthy:'Two or more peaks (bimodal), so the median describes no real item.',
    redflags:'A second hump far to the right - a class of work that is much slower.',
    ref:'Vacanti, Actionable Agile Metrics for Predictability'}
};
// The reusable chart + context row. o: {title, subtitle, chart(html), controls(html),
// benchKey, value(number|null), valueLabel(string), insight(string)}
function flowChartRow(o){
  const info=FLOW_METRIC_INFO[o.benchKey]||{};
  const cls=(o.value!=null)?flowClassify(o.benchKey,o.value):null;
  let ctx='<div class="fa-ctx-hd">ⓘ About this chart</div>';
  if(info.measures) ctx+='<div class="fa-ctx-txt">'+esc(info.measures)+'</div>';
  if(cls){
    const reach=flowReach(o.benchKey), gap=flowGap(o.benchKey,o.value);
    const gapCol=(cls.tier==='excellent'||cls.tier==='good')?'var(--green)':'var(--red)';
    ctx+='<div class="fa-ctx-lbl">Current status</div>'+
      '<div class="fa-status" style="color:'+cls.col+';background:'+cls.bg+';border-color:'+cls.bd+'">'+cls.label+'</div>'+
      '<div class="fa-ctx-val">Your value: '+esc(o.valueLabel!=null?o.valueLabel:String(o.value))+'</div>'+
      '<div class="fa-ctx-lbl">Where to reach</div><div class="fa-ctx-txt">'+esc(reach[0])+'<br>'+esc(reach[1])+'</div>'+
      '<div class="fa-ctx-lbl">Gap</div><div class="fa-ctx-txt" style="color:'+gapCol+'">'+esc(gap)+'</div>';
  }
  if(o.insight) ctx+='<div class="fa-insight">💡 '+esc(o.insight)+'</div>';
  if(info.measures){
    ctx+='<details class="fa-understand"><summary>Understanding this metric</summary><div class="fa-understand-bd">'+
      '<p><strong>Why it matters:</strong> '+esc(info.why||'')+'</p>'+
      '<p><strong>Healthy:</strong> '+esc(info.healthy||'')+'</p>'+
      '<p><strong>Unhealthy:</strong> '+esc(info.unhealthy||'')+'</p>'+
      '<p><strong>Red flags:</strong> '+esc(info.redflags||'')+'</p>'+
      (info.ref?'<p class="fa-ref">Reference: '+esc(info.ref)+'</p>':'')+
      '</div></details>';
  }
  const hasSvg=(o.chart||'').indexOf('<svg')>=0;
  return '<div class="fa-row"><div class="fa-row-chart">'+
    '<div class="fa-row-titlebar"><div class="fa-row-title">'+esc(o.title)+'</div>'+(hasSvg?flowExportBtn(o.title):'')+'</div>'+
    (o.subtitle?'<div class="fa-row-sub">'+esc(o.subtitle)+'</div>':'')+
    (o.chart||'')+(o.controls||'')+
    '</div><div class="fa-row-ctx">'+ctx+'</div></div>';
}
// Benchmark editor (settings)
function flowBenchEditor(){
  const host=q('#fa-bench-edit'); if(!host) return;
  const b=flowBench();
  let rows='';
  for(const k in b){ const m=b[k];
    rows+='<tr><td>'+esc(m.label)+'</td>'+
      m.t.map((v,i)=>'<td><input type="number" step="0.1" value="'+v+'" onchange="flowSetBench(\''+k+'\','+i+',this.value)"></td>').join('')+
      '<td>'+(m.dir==='lower'?'≤ better':'≥ better')+(m.unit?' ('+esc(m.unit)+')':'')+'</td></tr>';
  }
  host.innerHTML='<table class="fa-bench-tbl"><thead><tr><th>Metric</th><th>Excellent</th><th>Good</th><th>Attention</th><th>Dir</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    '<button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="flowResetBench()">Reset to defaults</button>';
}
function flowSetBench(key, i, val){
  const s=flowSettings(); s.bench=s.bench||{};
  const cur=(s.bench[key]||flowBench()[key].t).slice();
  cur[i]=parseFloat(val)||0; s.bench[key]=cur;
  flowPersist(); renderFlow();
}
function flowResetBench(){ const s=flowSettings(); delete s.bench; flowPersist(); flowBenchEditor(); renderFlow(); }

// ════════════════════════════════════════════════════════════════
// STICKY KPI STRIP + FLOATING NAV + ACCORDION GROUPS  -  V3-2
// ════════════════════════════════════════════════════════════════
const FLOW_GROUPS=[
  {id:'flow', label:'Flow',            col:'var(--primary)'},
  {id:'pred', label:'Predictability',  col:'var(--em)'},
  {id:'work', label:'Work management', col:'var(--amber)'}
];
function flowSparkline(series){
  const vals=(series||[]).filter(v=>v!=null);
  if(vals.length<2) return '';
  const min=Math.min(...vals), max=Math.max(...vals), span=(max-min)||1, W=64,H=16;
  const pts=vals.map((v,i)=>((i/(vals.length-1))*W).toFixed(1)+','+(H-((v-min)/span)*H).toFixed(1));
  return '<svg class="fa-spark" viewBox="0 0 '+W+' '+H+'" width="100%" height="16" preserveAspectRatio="none"><polyline points="'+pts.join(' ')+'" fill="none" stroke="var(--muted)" stroke-width="1.5"/></svg>';
}
function flowKpiCard(label, value, unit, series, betterDir){
  let delta='';
  if(series && betterDir){
    const vals=series.filter(v=>v!=null);
    if(vals.length>=2){
      const last=vals[vals.length-1], prev=vals[vals.length-2];
      if(prev){
        const pct=Math.round((last-prev)/Math.abs(prev)*100);
        if(pct===0) delta='<div class="fa-kpi-delta" style="color:var(--hint)">flat</div>';
        else{
          const improving = betterDir==='higher'?pct>0:pct<0;
          delta='<div class="fa-kpi-delta" style="color:'+(improving?'var(--green)':'var(--red)')+'">'+(last>prev?'▲':'▼')+' '+Math.abs(pct)+'%</div>';
        }
      }
    }
  }
  const isNum = value!=='-';
  return '<div class="fa-kpi-card"><div class="fa-kpi-lbl">'+esc(label)+'</div>'+
    '<div class="fa-kpi-val">'+esc(String(value))+(unit&&isNum?'<span class="fa-kpi-unit">'+esc(unit)+'</span>':'')+'</div>'+
    delta+(series?flowSparkline(series):'')+'</div>';
}
const FLOW_KPI_ALL=['total','throughput','medlead','medcycle','p85lead','p85cycle'];
let flowKpiFieldsOpen=false; // keep the "Choose metrics" accordion state across KPI re-renders
function flowKpiFields(){ const s=flowSettings(); if(!Array.isArray(s.kpiFields)) s.kpiFields=FLOW_KPI_ALL.slice(); return s.kpiFields; }
function flowToggleKpiField(key){ const arr=flowKpiFields(); const i=arr.indexOf(key);
  if(i>=0){ if(arr.length<=1){ if(typeof showToast==='function')showToast('Keep at least one metric shown','a'); return; } arr.splice(i,1); } else arr.push(key);
  flowPersist(); flowRenderKPI(); }
function flowRenderKPI(){
  const host=q('#fa-kpi'); if(!host) return;
  const durs=flowDurations();
  const completed=flowItems().filter(i=>i.completed);
  if(!completed.length){ host.innerHTML=''; return; }
  const periods=flowByPeriod(), win=6, tail=a=>a.slice(-win), dn=flowDaysNoun();
  const sortAsc=a=>a.slice().sort((x,y)=>x-y);
  const tpSeries=periods.map(p=>p.leads.length);
  const medLeadS=periods.map(p=>p.leads.length?flowPct(sortAsc(p.leads),50):null);
  const medCycS =periods.map(p=>p.cycles.length?flowPct(sortAsc(p.cycles),50):null);
  const p85LeadS=periods.map(p=>p.leads.length?flowPct(sortAsc(p.leads),85):null);
  const p85CycS =periods.map(p=>p.cycles.length?flowPct(sortAsc(p.cycles),85):null);
  const leads=durs.map(d=>d.lead).filter(v=>v!=null).sort((a,b)=>a-b);
  const cycles=durs.map(d=>d.cycle).filter(v=>v!=null).sort((a,b)=>a-b);
  const defs=[
    {key:'total', label:'Total items', card:flowKpiCard('Total items', completed.length, '', null, null)},
    {key:'throughput', label:'Throughput / '+flowPeriodNoun(), card:flowKpiCard('Throughput / '+flowPeriodNoun(), tpSeries.length?Math.round(flowStats(tpSeries).mean):0, '', tail(tpSeries), 'higher')},
    {key:'medlead', label:'Median lead', card:flowKpiCard('Median lead', leads.length?Math.round(flowPct(leads,50)):0, dn, tail(medLeadS), 'lower')},
    {key:'medcycle', label:'Median cycle', card:cycles.length?flowKpiCard('Median cycle', Math.round(flowPct(cycles,50)), dn, tail(medCycS), 'lower'):flowKpiCard('Median cycle','-','',null,null)},
    {key:'p85lead', label:'P85 lead', card:flowKpiCard('P85 lead', leads.length?Math.round(flowPct(leads,85)):0, dn, tail(p85LeadS), 'lower')},
    {key:'p85cycle', label:'P85 cycle', card:cycles.length?flowKpiCard('P85 cycle', Math.round(flowPct(cycles,85)), dn, tail(p85CycS), 'lower'):flowKpiCard('P85 cycle','-','',null,null)}
  ];
  const sel=flowKpiFields();
  const shown=defs.filter(d=>sel.indexOf(d.key)>=0);
  const chooser='<details class="fa-cmp-fields fa-kpi-fields"'+(flowKpiFieldsOpen?' open':'')+' ontoggle="flowKpiFieldsOpen=this.open"><summary>Choose metrics ('+shown.length+' of '+defs.length+')</summary><div class="fa-cmp-fieldgrid">'+
    defs.map(d=>'<label class="fa-cmp-fld"><input type="checkbox" '+(sel.indexOf(d.key)>=0?'checked':'')+' onchange="flowToggleKpiField(\''+d.key+'\')"> '+esc(d.label)+'</label>').join('')+'</div></details>';
  host.innerHTML='<div class="fa-kpi-strip">'+shown.map(d=>d.card).join('')+'</div>'+chooser;
}
function flowRenderNav(){
  const host=q('#fa-nav'); if(!host) return;
  if(!flowItems().filter(i=>i.completed).length){ host.innerHTML=''; return; }
  host.innerHTML='<div class="fa-nav-strip">'+FLOW_GROUPS.map(g=>
    '<button class="fa-nav-pill" style="color:'+g.col+'" onclick="flowNavTo(\''+g.id+'\')">'+esc(g.label)+'</button>').join('')+
    '<button class="fa-nav-pill" style="margin-left:auto" onclick="flowExportCharts()">📷 Save all charts</button></div>';
}
function flowNavTo(id){
  const grp=document.querySelector('[data-grp="'+id+'"]'); if(!grp) return;
  grp.classList.remove('collapsed');
  const body=grp.querySelector('.fa-acc-body'); if(body) body.style.display='';
  const chev=grp.querySelector('.fa-acc-chev'); if(chev) chev.textContent='▾';
  grp.scrollIntoView({behavior:'smooth', block:'start'});
}
function flowToggleGroup(id){
  const grp=document.querySelector('[data-grp="'+id+'"]'); if(!grp) return;
  const collapsed=grp.classList.toggle('collapsed');
  const body=grp.querySelector('.fa-acc-body'), chev=grp.querySelector('.fa-acc-chev');
  if(body) body.style.display=collapsed?'none':'';
  if(chev) chev.textContent=collapsed?'▸':'▾';
}

// ════════════════════════════════════════════════════════════════
// SUB-NAVIGATION & RENDER ENTRY
// ════════════════════════════════════════════════════════════════
function renderPage4(){
  flowSyncInputs();
  if(flowSub==='sprint'){ if(typeof renderAnalytics==='function') renderAnalytics(); }
  else if(flowSub==='guide'){ flowRenderGuide(); }
  else if(flowSub==='monte'){ flowRenderMC(); }
  else { renderFlow(); }
}
function flowSubTab(which){
  flowSub = which;
  q('#sub-flow').style.display   = which==='flow'   ? '' : 'none';
  q('#sub-sprint').style.display = which==='sprint' ? 'block' : 'none';
  const g=q('#sub-guide'); if(g) g.style.display = which==='guide' ? 'block' : 'none';
  const m=q('#sub-monte'); if(m) m.style.display = which==='monte' ? 'block' : 'none';
  document.querySelectorAll('.fa-subtab').forEach(b=>b.classList.toggle('active', b.dataset.sub===which));
  renderPage4();
}
function flowInputTab(which){
  flowInput = which;
  q('#fa-tc-csv').style.display  = which==='csv'  ? 'block' : 'none';
  q('#fa-tc-jira').style.display = which==='jira' ? 'block' : 'none';
  document.querySelectorAll('.fa-itab').forEach(b=>b.classList.toggle('active', b.dataset.fin===which));
}
// reflect current settings into the controls when the page opens
function flowSyncInputs(){
  const st = flowSettings();
  const set=(id,v)=>{ const el=q(id); if(el) el.value=v; };
  set('#fa-set-calc', st.periodCalc);
  set('#fa-set-span', st.timeSpan);
  set('#fa-set-fmt', st.dateFormat);
  set('#fa-set-start', st.sprintStart);
  set('#fa-set-len', st.sprintLength);
  set('#fa-set-sameday', st.sameDayValue);
  flowBenchEditor();
  flowRenderAnnotEditor();
}

// ════════════════════════════════════════════════════════════════
// MAIN FLOW RENDER  (data summary + preview, or empty state)
// ════════════════════════════════════════════════════════════════
function renderFlow(){
  flowMaybeHydrate();          // one-shot: pull the shared cache if this browser has no data yet
  flowRenderSyncNote();        // show when Jira was last synced
  const items = flowItems();
  const host = q('#fa-data-out');
  if(!host) return;
  if(!items.length){
    host.innerHTML =
      '<div class="fa-empty">'+
        '<div class="fa-empty-ico">📥</div>'+
        '<h4>No item-level data yet</h4>'+
        '<p>Flow metrics need one row per ticket (with created &amp; completed dates). '+
        'Import a Jira issue CSV export or fetch issues from the Jira API above to get started.</p>'+
        '<div style="margin-top:14px"><button class="btn btn-primary btn-sm" onclick="flowLoadSample()">Try with 100 sample items</button></div>'+
      '</div>';
    const sf=q('#sub-flow'); if(sf) sf.classList.remove('has-data');
    const sk=q('#fa-sticky'); if(sk) sk.style.display='none';
    ['#fa-health-card','#fa-recs-card','#fa-datatable-card','#fa-persprint-card'].forEach(id=>{ const el=q(id); if(el) el.style.display='none'; });
    flowScope=''; flowRenderScopeBar();
    flowRenderKPI(); flowRenderNav();
    flowRenderGroupFlow(); flowRenderGroupPred(); flowRenderGroupWork();
    return;
  }
  // summary
  const completed = items.filter(i=>i.completed).length;
  const withStart = items.filter(i=>i.started).length;
  const types = {};
  items.forEach(i=>{ const t=flowNormType(i.type); types[t]=(types[t]||0)+1; });
  const dates = items.map(i=>i.completed||i.created).filter(Boolean).sort();
  const span = dates.length ? (dates[0]+'  →  '+dates[dates.length-1]) : '-';
  const typeStr = Object.entries(types).map(([k,v])=>k+' '+v).join(' · ') || '-';

  let html = '<div class="fa-summary">'+
    flowSCard('Items', items.length, 'total rows')+
    flowSCard('Completed', completed, 'have a done date')+
    flowSCard('With start date', withStart, 'enables cycle time')+
    flowSCard('Date range', dates.length? (dates.length+' dated') : '0', span)+
  '</div>';
  if(!withStart){
    html += '<div class="fa-warn amber">⚠ <span>No <strong>Start date</strong> mapped. Throughput, lead time, and forecasting work fine; '+
            '<strong>cycle time</strong> and flow efficiency (later phases) need a start date.</span></div>';
  }
  html += '<div class="fa-sec-hint" style="margin-top:16px">Work type mix: '+esc(typeStr)+'</div>';

  // preview table (first 50)
  const show = items.slice(0, 50);
  html += '<div class="fa-prev-wrap"><div class="fa-prev-scroll"><table class="fa-prev"><thead><tr>'+
    '<th>ID</th><th>Type</th><th>Status</th><th>Created</th><th>Started</th><th>Completed</th><th class="num">Pts</th><th>Sprint</th>'+
    '</tr></thead><tbody>';
  show.forEach(i=>{
    html += '<tr>'+
      '<td>'+esc(i.id||'-')+'</td>'+
      '<td><span class="fa-pill '+flowTypeClass(flowNormType(i.type))+'">'+esc(flowNormType(i.type))+'</span></td>'+
      '<td><span class="fa-pill '+flowStatusClass(i.statusCategory||i.status)+'">'+esc(i.status||'-')+'</span></td>'+
      '<td>'+esc(i.created||'-')+'</td>'+
      '<td>'+esc(i.started||'-')+'</td>'+
      '<td>'+esc(i.completed||'-')+'</td>'+
      '<td class="num">'+(i.points||'')+'</td>'+
      '<td>'+esc(i.sprint||'-')+'</td>'+
    '</tr>';
  });
  html += '</tbody></table></div><div class="fa-prev-foot">Showing '+show.length+' of '+items.length+' items · '+
    '<button class="btn btn-ghost btn-sm" onclick="flowClearData()" style="padding:2px 8px">Clear data</button></div></div>';

  host.innerHTML = html;
  const sf=q('#sub-flow'); if(sf) sf.classList.add('has-data');
  const sk=q('#fa-sticky'); if(sk) sk.style.display='';
  ['#fa-health-card','#fa-recs-card','#fa-datatable-card'].forEach(id=>{ const el=q(id); if(el) el.style.display=''; });
  flowRenderKPI(); flowRenderNav();
  flowRenderHealth(); flowRenderRecs();
  flowRenderGroupFlow(); flowRenderGroupPred(); flowRenderGroupWork();
  flowRenderDataTable();
  const psc=q('#fa-persprint-card'); if(psc) psc.style.display='';
  flowRenderScopeBar(); flowRenderPerSprint();
}
// Scope selector: narrow the whole Flow Metrics tab to one sprint, or all.
function flowRenderScopeBar(){
  const host=q('#fa-scopebar'); if(!host) return;
  const sprints=flowSprintList();
  if(!sprints.length){ host.innerHTML=''; flowScope=''; return; }
  if(flowScope && sprints.indexOf(flowScope)<0) flowScope='';
  const opts='<option value="">All sprints</option>'+sprints.map(s=>'<option value="'+esc(s)+'"'+(s===flowScope?' selected':'')+'>'+flowSprintLabel(s)+'</option>').join('');
  host.innerHTML='<div class="fa-scopebar-inner"><label class="fl" style="margin:0">Scope</label>'+
    '<select onchange="flowSetScope(this.value)">'+opts+'</select>'+
    '<span class="fa-sec-hint" style="margin:0">'+(flowScope
      ? ('Showing <strong>'+esc(flowScope)+'</strong> only — the KPIs, charts, health and forecast below are for this sprint.')
      : 'Showing <strong>all sprints</strong> combined. Pick one to drill the metrics into a single sprint.')+'</span></div>';
}
// Per-sprint breakdown table: every sprint's flow criteria plus an overall row.
function flowRenderPerSprint(){
  const host=q('#fa-persprint'); if(!host) return;
  const sprints=flowSprintList();
  if(!sprints.length){ host.innerHTML='<div class="fa-sec-hint">Import items that carry a Sprint field to see per-sprint flow metrics.</div>'; return; }
  const dn=flowDaysNoun();
  const cols=[['done','Done',''],['rate','Rate','%'],['donePts','Pts',''],['medLead','Med lead',' '+dn],['p85Lead','P85 lead',' '+dn],['medCycle','Med cycle',' '+dn],['flowEff','Flow eff','%'],['defectRate','Defect','%'],['contributors','Contrib','']];
  const num=(v,u)=>v==null?'-':(v+(u||''));
  const rowFor=(label,st,cls)=>'<tr'+(cls?(' class="'+cls+'"'):'')+'><td>'+label+'</td><td class="num">'+st.total+'</td>'+cols.map(c=>'<td class="num">'+num(st[c[0]],c[2])+'</td>').join('')+'</tr>';
  let rows='';
  sprints.forEach(s=>{ rows+=rowFor(flowSprintLabel(s), flowSprintStats(s)); });
  rows+=rowFor('<strong>All sprints</strong>', flowStatsFor(flowAllItems(), flowAllDurations(), 'All sprints'), 'fa-ps-overall');
  host.innerHTML='<div class="fa-sec-hint">Every sprint\'s flow criteria at a glance, with the overall total in the last row. Use the Scope selector at the top to drill the charts into a single sprint.</div>'+
    '<div style="overflow-x:auto"><table class="fa-cmp-tbl fa-ps-tbl"><thead><tr><th>Sprint</th><th class="num">Items</th>'+cols.map(c=>'<th class="num">'+c[1]+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function flowSCard(lbl, val, sub){
  return '<div class="fa-scard"><div class="fa-scard-lbl">'+esc(lbl)+'</div>'+
    '<div class="fa-scard-val">'+esc(String(val))+'</div>'+
    '<div class="fa-scard-sub">'+esc(sub||'')+'</div></div>';
}
function flowClearData(){
  if(!confirm('Clear all imported flow items for this team?')) return;
  flowSetItems([]);
  renderFlow();
  showToast('Flow data cleared','g');
}

// ════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════
function flowSetChange(key, val){
  const st = flowSettings();
  if(key==='sprintLength') val = Math.max(1, Math.min(4, +val||2));
  if(key==='sameDayValue') val = Math.max(0, +val||0);
  st[key] = val;
  flowPersist();
  renderFlow();
}

// ════════════════════════════════════════════════════════════════
// CSV IMPORT  (issue-level)
// ════════════════════════════════════════════════════════════════
const FLOW_FIELDS = [
  {k:'id',        lbl:'Issue ID / Key',  req:false, rx:/(issue\s*key|^key$|^id$|issue\s*id)/i},
  {k:'type',      lbl:'Work Type',       req:false, rx:/(issue\s*type|work\s*type|^type$)/i},
  {k:'status',    lbl:'Status',          req:false, rx:/^status$|status\s*name/i},
  {k:'created',   lbl:'Created Date',    req:true,  rx:/created/i},
  {k:'started',   lbl:'Start Date',      req:false, rx:/(start|in\s*progress|began)/i},
  {k:'completed', lbl:'Completed Date',  req:true,  rx:/(resolved|done|completed|closed|status\s*category\s*changed)/i},
  {k:'points',    lbl:'Story Points',    req:false, rx:/(story\s*point|points|^sp$|estimate)/i},
  {k:'sprint',    lbl:'Sprint',          req:false, rx:/sprint/i},
  {k:'assignee',  lbl:'Assignee',        req:false, rx:/^assignee$/i}
];
function flowCsvDragOver(e){ e.preventDefault(); q('#fa-drop').classList.add('drag'); }
function flowCsvDragLeave(){ q('#fa-drop').classList.remove('drag'); }
function flowCsvDropped(e){ e.preventDefault(); flowCsvDragLeave(); flowReadCsv(e.dataTransfer.files[0]); }
function flowCsvChosen(e){ flowReadCsv(e.target.files[0]); }
function flowReadCsv(f){
  if(!f) return;
  const r = new FileReader();
  r.onload = ev => flowPrepMap(ev.target.result);
  r.readAsText(f);
}
function flowPrepMap(text){
  const rows = parseCSV(text);
  if(rows.length < 2){ showToast('CSV needs a header row + data','r'); return; }
  flowCsv.headers = rows[0];
  flowCsv.rows = rows.slice(1).filter(r=>r.some(c=>c!=='' && c!=null));
  const blank = '<option value="-1">- none -</option>';
  const opts = flowCsv.headers.map((h,i)=>'<option value="'+i+'">'+esc(h)+'</option>').join('');
  let grid = '';
  FLOW_FIELDS.forEach(f=>{
    grid += '<div class="fi"><label class="fl">'+esc(f.lbl)+
      (f.req?' <span class="fa-req">*</span>':' <span class="fa-opt">(optional)</span>')+'</label>'+
      '<select id="fa-col-'+f.k+'">'+blank+opts+'</select></div>';
  });
  q('#fa-map-grid').innerHTML = grid;
  // apply guesses
  FLOW_FIELDS.forEach(f=>{
    const guess = flowCsv.headers.findIndex(h=>f.rx.test(h));
    const sel = q('#fa-col-'+f.k);
    if(sel && guess>=0) sel.value = guess;
  });
  q('#fa-map').style.display = 'block';
}
function flowImportCsv(){
  const col = {};
  FLOW_FIELDS.forEach(f=>{ col[f.k] = +q('#fa-col-'+f.k).value; });
  if(col.created<0 || col.completed<0){
    showToast('Map at least Created and Completed dates','r'); return;
  }
  // resolve date format
  const st = flowSettings();
  if(st.dateFormat==='auto'){
    const sample = [];
    flowCsv.rows.forEach(r=>{ if(col.created>=0) sample.push(r[col.created]); if(col.completed>=0) sample.push(r[col.completed]); });
    flowDetectedFmt = flowDetectFormat(sample);
  } else {
    flowDetectedFmt = st.dateFormat;
  }
  const get = (r,k)=> col[k]>=0 ? (r[col[k]]||'') : '';
  const items = flowCsv.rows.map(r=>{
    const created   = flowParseDate(get(r,'created'),   st.dateFormat);
    const started   = flowParseDate(get(r,'started'),   st.dateFormat);
    const completed = flowParseDate(get(r,'completed'), st.dateFormat);
    return {
      id:        get(r,'id'),
      type:      get(r,'type'),
      status:    get(r,'status'),
      statusCategory: get(r,'status'),
      created:   flowToISO(created),
      started:   flowToISO(started),
      completed: flowToISO(completed),
      points:    parseFloat(get(r,'points'))||0,
      sprint:    get(r,'sprint'),
      assignee:  get(r,'assignee')
    };
  }).filter(i=> i.created || i.completed);
  if(!items.length){ showToast('No rows parsed - check column mapping','r'); return; }
  flowSetItems(items);
  q('#fa-map').style.display='none';
  const amb = (st.dateFormat==='auto' && flowDetectedFmt===null);
  showToast(items.length+' items imported','g');
  if(amb) showToast('Date format was ambiguous - set it in Settings if dates look wrong','a');
  renderFlow();
}

// ════════════════════════════════════════════════════════════════
// JIRA API IMPORT  (issue search via JQL)  - PAT never stored
// ════════════════════════════════════════════════════════════════
// ── Connector-backed Jira access (no CORS, no token in the browser) ──
// The vibe calls the installed `eng-metrics-jira` connector same-origin at
// /api/vibes/{owner}/{vibe}/connectors/eng-metrics-jira/... The connector holds
// the Jira email + API token server-side and returns processed, flat tickets.
const JIRA_CONNECTOR_ID='eng-metrics-jira';
function jiraConnBase(){
  const m=(location.pathname||'').match(/\/v\/([^\/]+)\/([^\/]+)/);
  return m ? '/api/vibes/'+m[1]+'/'+m[2]+'/connectors/'+JIRA_CONNECTOR_ID : null;
}
function jiraConnUnavailableMsg(){
  return 'The Jira connector only responds on the deployed vibe. Open this app at its vibes.hudltools.com/v/... URL (it will not work from a local file or the editor preview).';
}
// ── Rate-limit tracking: gate fetches until the connector's reset so we stop hammering it ──
let jiraRateLimitUntil=0;      // ms timestamp; while now < this, block outgoing requests
let jiraLastTruncated=false;   // set when a search stops at the page cap (more results existed)
function jiraRateLimited(){ return jiraRateLimitUntil>0 && Date.now()<jiraRateLimitUntil; }
function jiraRateResetLabel(){ if(!jiraRateLimitUntil) return ''; const d=new Date(jiraRateLimitUntil); return String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' UTC'; }
function jiraNoteRateLimit(msg){
  const m=/Resets? at (\d{1,2}):(\d{2})\s*UTC/i.exec(msg||'');
  if(m){ const now=new Date(); const t=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),+m[1],+m[2],0,0)); if(t.getTime()<=now.getTime()) t.setUTCDate(t.getUTCDate()+1); jiraRateLimitUntil=t.getTime(); }
  else { jiraRateLimitUntil=Date.now()+60000; }   // burst limit without a reset time -> back off 60s
}
// Turns a fetch Response into parsed JSON, throwing clear messages (and noting 429 resets).
async function jiraConnJson(r){
  let d; try{ d=await r.json(); }catch(e){ d=null; }
  if(r.status===429 || (d && d.error && /rate limit/i.test(d.error))){ const msg=(d&&d.error)||'Jira rate limit exceeded (HTTP 429).'; jiraNoteRateLimit(msg); throw new Error(msg); }
  if(!r.ok || (d && d.error)) throw new Error((d&&d.error)||('HTTP '+r.status));
  if(!d) throw new Error('Connector returned a non-JSON response (HTTP '+r.status+')');
  return d;
}
// Paginated JQL search -> flat ticket array. Follows nextPageToken until exhausted or the cap.
async function jiraConnSearch(jql, opts){
  opts=opts||{}; const max=opts.max||1000; const base=jiraConnBase();   // 1000-item cap = up to ~10 requests
  if(!base) throw new Error(jiraConnUnavailableMsg());
  if(jiraRateLimited()) throw new Error('Jira rate limit exceeded. Try again after '+jiraRateResetLabel()+'.');
  jiraLastTruncated=false;
  let all=[], token=null, guard=0;
  do{
    const body={jql:jql, maxResults:100}; if(token) body.nextPageToken=token;
    const r=await fetch(base+'/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await jiraConnJson(r);
    all=all.concat(d.tickets||[]); token=d.nextPageToken;
  }while(token && all.length<max && guard++<80);
  if(token && all.length>=max) jiraLastTruncated=true;   // hit the cap with more available
  return all;
}
// Board sprints (most-recent-first): [{id,name,state,startDate,endDate}]
async function jiraConnSprints(boardId){
  const base=jiraConnBase(); if(!base) throw new Error(jiraConnUnavailableMsg());
  if(jiraRateLimited()) throw new Error('Jira rate limit exceeded. Try again after '+jiraRateResetLabel()+'.');
  const r=await fetch(base+'/sprints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({boardId:+boardId})});
  const d=await jiraConnJson(r);
  return d.sprints||[];
}
// Map one connector ticket onto the flow item model. Points, sprint and the
// started/done transition dates already come resolved from the connector.
function jiraTicketToItem(t){
  return {
    id: t.key||'',
    type: t.type||'',
    status: t.status||'',
    statusCategory: t.status_category||'',
    created: t.created_date?flowToISO(flowParseDate(t.created_date)):'',
    started: t.started_date?flowToISO(flowParseDate(t.started_date)):'',
    completed: t.resolution_date?flowToISO(flowParseDate(t.resolution_date)):'',
    points: (t.story_points!=null?(+t.story_points||0):0),
    sprint: t.sprint||'',
    assignee: t.assignee||''
  };
}
async function flowFetchJiraConnector(){
  const jql=(q('#fa-jira-jql').value||'').trim();
  if(!jql){ showToast('Enter a JQL filter','r'); return; }
  const btn=q('#fa-jira-btn'), err=q('#fa-cors');
  if(btn){ btn.disabled=true; btn.textContent='Fetching…'; }
  if(err) err.style.display='none';
  try{
    const tix=await jiraConnSearch(jql);
    if(!tix.length){ showToast('No issues returned for that JQL','a'); return; }
    const items=tix.map(jiraTicketToItem);
    flowSetItems(items);
    const t=at(); if(t){ if(!flowStore.teams[t.id]) flowStore.teams[t.id]={}; flowStore.teams[t.id].fromCache=false; }
    showToast(tix.length+' issues loaded from Jira','g');
    renderFlow();
    flowCacheSave(items, jql);   // write-through to the shared cache (fire-and-forget)
    if(jiraLastTruncated && err){ err.style.display='block'; err.innerHTML='Loaded the first '+tix.length+' issues (cap reached). Narrow the JQL, e.g. add <code>resolutiondate &gt;= -90d</code>, to pull fewer.'; }
  }catch(e){
    if(err){ err.style.display='block'; err.innerHTML='<strong>Jira fetch failed.</strong> '+esc(String(e&&e.message||e)); }
    showToast('Jira fetch failed','r');
  }finally{
    if(btn){ btn.disabled=false; btn.textContent='Fetch Issues'; }
  }
}
// Ingest raw connector tickets into the item-level flow store (used by the Velocity import
// so one Jira pull also powers the Analytics tab). Lives here so flowStore access stays in-file.
function flowIngestTickets(tickets, label){
  const items=(tickets||[]).map(jiraTicketToItem);
  if(!items.length) return 0;
  flowSetItems(items);
  const t=at(); if(t){ if(!flowStore.teams[t.id]) flowStore.teams[t.id]={}; flowStore.teams[t.id].fromCache=false; }
  flowCacheSave(items, label||'velocity import');
  if(typeof renderFlow==='function') renderFlow();
  return items.length;
}
function flowImportJira(fPts, fSpr, fStart){
  const sprintName = v => {
    if(!v) return '';
    if(Array.isArray(v)){ const last=v[v.length-1]; if(!last) return '';
      if(typeof last==='string'){ const m=last.match(/name=([^,]+)/); return m?m[1]:last; }
      return last.name||''; }
    return (typeof v==='object') ? (v.name||'') : String(v);
  };
  const items = flowJira.map(it=>{
    const f = it.fields||{};
    return {
      id:        it.key||'',
      type:      (f.issuetype&&f.issuetype.name)||'',
      status:    (f.status&&f.status.name)||'',
      statusCategory: (f.status&&f.status.statusCategory&&f.status.statusCategory.name)||(f.status&&f.status.name)||'',
      created:   flowToISO(flowParseDate(f.created)),
      started:   fStart ? flowToISO(flowParseDate(f[fStart])) : '',
      completed: flowToISO(flowParseDate(f.resolutiondate)),
      points:    fPts ? (parseFloat(f[fPts])||0) : 0,
      sprint:    fSpr ? sprintName(f[fSpr]) : '',
      assignee:  (f.assignee&&f.assignee.displayName)||''
    };
  });
  flowSetItems(items);
  showToast(items.length+' issues loaded from Jira','g');
  renderFlow();
}

// ════════════════════════════════════════════════════════════════
// MONTE CARLO  -  Checkpoint 1B
// ════════════════════════════════════════════════════════════════
const FLOW_CONF = [
  {p:50, lbl:'Coin Flip',       col:'#FCA5A5'},
  {p:70, lbl:'Likely',          col:'#FBBF24'},
  {p:80, lbl:'Probable',        col:'#38BDF8'},
  {p:85, lbl:'Safe Bet',        col:'#059669'},
  {p:90, lbl:'High Confidence', col:'#10B981'},
  {p:95, lbl:'Near Certain',    col:'#047857'}
];
function flowPeriodNoun(plural){
  const m={weekly:'week',biweekly:'sprint',monthly:'month',quarterly:'quarter',yearly:'year'};
  const w=m[flowSettings().timeSpan]||'period';
  return plural?w+'s':w;
}
function flowMetricNoun(){ return flowMcMetric==='points'?'points':'items'; }

// Derive per-period throughput samples from item data (or fall back to sprint velocity).
function flowVelocitySamples(metric){
  const items = flowItems().filter(i=>i.completed);
  const st = flowSettings();
  if(items.length){
    const haveSprint = items.filter(i=>i.sprint).length >= items.length*0.5;
    const groups = {};
    if(haveSprint){
      items.forEach(i=>{ const k=i.sprint||'(none)'; (groups[k]=groups[k]||[]).push(i); });
    }else{
      items.forEach(i=>{ const d=flowParseISO(i.completed); if(!d)return; const k=flowPeriodOf(d,st).key; (groups[k]=groups[k]||[]).push(i); });
    }
    const samples = Object.values(groups)
      .map(arr=> metric==='points' ? arr.reduce((s,i)=>s+(+i.points||0),0) : arr.length)
      .filter(v=>v>0);
    if(samples.length) return {samples, source: haveSprint?'sprint column':'completion period'};
  }
  // fallback: existing sprint velocity history (points only)
  const t = at();
  const vh = (t&&t.sprints||[]).filter(s=>s.sel!==false).map(s=>+s.pts).filter(v=>v>0);
  if(vh.length) return {samples:vh, source:'velocity history (points)', forcePoints:true};
  return {samples:[], source:'none'};
}
function flowGetSamples(){
  if(flowMcManual && flowMcManual.length) return {samples:flowMcManual.slice(), source:'manual'};
  return flowVelocitySamples(flowMcMetric);
}
function flowStats(a){
  if(!a.length) return {mean:0,sd:0,cov:0};
  const mean=a.reduce((s,x)=>s+x,0)/a.length;
  const v=a.reduce((s,x)=>s+(x-mean)*(x-mean),0)/a.length;
  const sd=Math.sqrt(v);
  return {mean, sd, cov: mean?sd/mean:0};
}
function flowPct(sorted, p){
  if(!sorted.length) return 0;
  const idx=Math.min(sorted.length-1, Math.max(0, Math.round((p/100)*(sorted.length-1))));
  return sorted[idx];
}
// Simulations
function flowSimHowMany(s, n, trials){
  const L=s.length, out=new Array(trials);
  for(let t=0;t<trials;t++){ let sum=0; for(let k=0;k<n;k++) sum+=s[(Math.random()*L)|0]; out[t]=sum; }
  return out.sort((a,b)=>a-b);
}
function flowSimWhenDone(s, target, split, trials){
  const L=s.length, out=new Array(trials), cap=1000, f=split/100;
  for(let t=0;t<trials;t++){
    let rem=target, k=0;
    while(rem>0 && k<cap){ const d=s[(Math.random()*L)|0]; rem-=d; if(f>0) rem+=d*f; k++; }
    out[t]=k;
  }
  return out.sort((a,b)=>a-b);
}
function flowSimBurnup(s, trials, maxK){
  const L=s.length, per=Array.from({length:maxK},()=>new Array(trials));
  for(let t=0;t<trials;t++){ let cum=0; for(let k=0;k<maxK;k++){ cum+=s[(Math.random()*L)|0]; per[k][t]=cum; } }
  per.forEach(a=>a.sort((x,y)=>x-y));
  return per;
}

// ── RENDER ─────────────────────────────────────────────────────
function flowRenderMC(){
  const host=q('#fa-mc-out'); if(!host) return;
  const sm=flowGetSamples();
  if(!sm.samples.length){
    host.innerHTML='<div class="fa-empty"><div class="fa-empty-ico">🎲</div>'+
      '<h4>Forecasting needs velocity samples</h4>'+
      '<p>Import item-level data above, or add sprint velocity history in the Team Velocity tab. '+
      'Then Monte Carlo will simulate 10,000 futures from your actual delivery.</p></div>';
    return;
  }
  const st=flowStats(sm.samples);
  const covPct=Math.round(st.cov*100);
  const badge = st.cov<0.5?'green':(st.cov<0.75?'amber':'red');
  const badgeTxt = st.cov<0.5?'stable':(st.cov<0.75?'moderate':'volatile');
  const samplesStr = (flowMcManual&&flowMcManual.length?flowMcManual:sm.samples).map(v=>Math.round(v*10)/10).join(', ');

  let html='';
  // mode cards
  html+='<div class="fa-mc-modes">'+
    flowModeCard('howmany','How Many','How much can we deliver in N '+flowPeriodNoun(true)+'? Ideal for sprint commitments.')+
    flowModeCard('whendone','When Done','When will we finish a target backlog? Ideal for roadmap deadlines.')+
  '</div>';

  // controls
  html+='<div class="fa-mc-controls">';
  html+='<div class="fi"><label class="fl">Forecast by</label><div class="fa-toggle">'+
    '<button class="'+(flowMcMetric==='count'?'active':'')+'" onclick="flowSetMcMetric(\'count\')">Throughput</button>'+
    '<button class="'+(flowMcMetric==='points'?'active':'')+'" onclick="flowSetMcMetric(\'points\')">Story Points</button></div></div>';
  if(flowMcMode==='howmany'){
    html+='<div class="fi"><label class="fl">Number of '+flowPeriodNoun(true)+'</label>'+
      '<input type="number" min="1" max="52" value="'+flowMcN+'" onchange="flowMcInput()" id="fa-mc-n"></div>';
  }else{
    html+='<div class="fi"><label class="fl">Backlog size ('+flowMetricNoun()+')</label>'+
      '<input type="number" min="1" value="'+flowMcTarget+'" onchange="flowMcInput()" id="fa-mc-target"></div>';
    html+='<div class="fi"><label class="fl">Split rate % <span class="fa-opt">(scope creep)</span></label>'+
      '<input type="number" min="0" max="100" value="'+flowMcSplit+'" onchange="flowMcInput()" id="fa-mc-split"></div>';
  }
  html+='<div class="fi" style="grid-column:1/-1"><label class="fl">Velocity samples ('+flowMetricNoun()+' per '+flowPeriodNoun()+', from '+esc(sm.source)+')</label>'+
    '<input type="text" value="'+esc(samplesStr)+'" onchange="flowMcSetManual(this.value)" id="fa-mc-samples">'+
    '<div><span class="fa-vel-badge '+badge+'">CoV '+covPct+'% · '+badgeTxt+'</span>'+
    (flowMcManual?' <button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="flowMcResetSamples()">reset to auto</button>':'')+'</div>'+
    (st.cov>=0.75?'<div class="fa-set-note">High variability - forecasts will be wide. Consider narrowing the sample window for steadier numbers.</div>':'')+'</div>';
  html+='</div>';

  // results placeholder (filled by flowRunMC)
  html+='<div id="fa-mc-results"></div>';

  host.innerHTML=html;
  flowRunMC(sm.samples);
}
function flowModeCard(mode, title, desc){
  return '<button class="fa-mc-mode'+(flowMcMode===mode?' active':'')+'" onclick="flowSetMcMode(\''+mode+'\')">'+
    '<div class="fa-mc-mode-t">'+esc(title)+'</div><div class="fa-mc-mode-d">'+esc(desc)+'</div></button>';
}
function flowSetMcMode(m){ flowMcMode=m; flowRenderMC(); }
function flowSetMcMetric(m){ flowMcMetric=m; flowMcManual=null; flowRenderMC(); }
function flowMcInput(){
  const n=q('#fa-mc-n'), tg=q('#fa-mc-target'), sp=q('#fa-mc-split');
  if(n) flowMcN=Math.max(1,Math.min(52,+n.value||6));
  if(tg) flowMcTarget=Math.max(1,+tg.value||1);
  if(sp) flowMcSplit=Math.max(0,Math.min(100,+sp.value||0));
  const sm=flowGetSamples(); flowRunMC(sm.samples);
}
function flowMcSetManual(str){
  const arr=String(str).split(/[,\s]+/).map(x=>parseFloat(x)).filter(x=>!isNaN(x)&&x>0);
  flowMcManual = arr.length?arr:null;
  flowRenderMC();
}
function flowMcResetSamples(){ flowMcManual=null; flowRenderMC(); }

function flowRunMC(samples){
  const host=q('#fa-mc-results'); if(!host) return;
  if(!samples||!samples.length){ host.innerHTML=''; return; }
  let html='';
  if(flowMcMode==='howmany'){
    const totals=flowSimHowMany(samples, flowMcN, FLOW_TRIALS);
    html+='<div class="fa-sec-hint" style="margin-top:16px">In <strong>'+flowMcN+' '+flowPeriodNoun(flowMcN>1)+'</strong>, your team will likely deliver:</div>';
    html+='<div class="fa-conf-grid">'+FLOW_CONF.map(c=>{
      const v=Math.round(flowPct(totals, 100-c.p));   // p% chance of AT LEAST v
      return flowConfCard(c, v, flowMetricNoun(), c.p===85);
    }).join('')+'</div>';
    html+=flowHistogramSVG(totals);
    html+='<div class="fa-mc-foot">Read as: "'+85+'% confident we will complete <strong>at least</strong> the Safe Bet amount in '+flowMcN+' '+flowPeriodNoun(flowMcN>1)+'." Based on '+FLOW_TRIALS.toLocaleString()+' simulations resampling your '+samples.length+' velocity '+flowPeriodNoun(samples.length>1)+'.</div>';
  }else{
    const counts=flowSimWhenDone(samples, flowMcTarget, flowMcSplit, FLOW_TRIALS);
    html+='<div class="fa-sec-hint" style="margin-top:16px">To finish <strong>'+flowMcTarget+' '+flowMetricNoun()+'</strong>'+(flowMcSplit>0?' (with '+flowMcSplit+'% scope creep)':'')+', it will likely take:</div>';
    html+='<div class="fa-conf-grid">'+FLOW_CONF.map(c=>{
      const v=Math.round(flowPct(counts, c.p));        // done within v periods with p% confidence
      return flowConfCard(c, v, flowPeriodNoun(true), c.p===85);
    }).join('')+'</div>';
    const maxK=Math.min(40, Math.max(3, Math.round(flowPct(counts,95))+1));
    html+=flowBurnupSVG(samples, flowMcTarget, flowMcSplit, maxK);
    if(flowMcSplit>0){
      const noCreep=flowSimWhenDone(samples, flowMcTarget, 0, FLOW_TRIALS);
      html+='<div class="fa-mc-foot">Scope creep impact (Safe Bet 85%): <strong>'+Math.round(flowPct(counts,85))+' '+flowPeriodNoun(true)+'</strong> with '+flowMcSplit+'% creep vs <strong>'+Math.round(flowPct(noCreep,85))+' '+flowPeriodNoun(true)+'</strong> without. '+FLOW_TRIALS.toLocaleString()+' simulations.</div>';
    }else{
      html+='<div class="fa-mc-foot">Read as: "'+85+'% confident we will be done within the Safe Bet number of '+flowPeriodNoun(true)+'." Based on '+FLOW_TRIALS.toLocaleString()+' simulations.</div>';
    }
  }
  host.innerHTML=html;
}
function flowConfCard(c, val, unit, hl){
  return '<div class="fa-conf'+(hl?' hl':'')+'" style="'+(hl?'':'border-color:'+c.col+'33')+'">'+
    '<div class="fa-conf-lbl" style="color:'+c.col+'">'+esc(c.lbl)+'</div>'+
    '<div class="fa-conf-pct">'+c.p+'%</div>'+
    '<div class="fa-conf-val">'+val+'</div>'+
    '<div class="fa-conf-unit">'+esc(unit)+'</div>'+
    '<div class="fa-conf-tag">◆ commit here</div></div>';
}

// ── CHARTS (SVG) ───────────────────────────────────────────────
function flowHistogramSVG(sorted){
  const min=sorted[0], max=sorted[sorted.length-1];
  const W=720,H=260, ml=44,mr=12,mt=12,mb=30, pw=W-ml-mr, ph=H-mt-mb;
  const nB=Math.min(18, Math.max(6, Math.round(Math.sqrt(sorted.length/40))||12));
  const span=(max-min)||1, bw=span/nB;
  const bins=new Array(nB).fill(0);
  sorted.forEach(v=>{ let b=Math.floor((v-min)/bw); if(b>=nB)b=nB-1; if(b<0)b=0; bins[b]++; });
  const maxC=Math.max(...bins)||1;
  const p85=flowPct(sorted,15); // Safe Bet (85% chance of at least this)
  const x=v=>ml+((v-min)/span)*pw;
  const barW=pw/nB;
  let bars='';
  bins.forEach((c,i)=>{
    const bx=ml+i*barW, bh=(c/maxC)*ph, by=mt+ph-bh;
    bars+='<rect x="'+(bx+1).toFixed(1)+'" y="'+by.toFixed(1)+'" width="'+(barW-2).toFixed(1)+'" height="'+bh.toFixed(1)+'" rx="2" fill="#C7D2FE"/>';
  });
  const lx=x(p85);
  const marker='<line x1="'+lx.toFixed(1)+'" y1="'+mt+'" x2="'+lx.toFixed(1)+'" y2="'+(mt+ph)+'" stroke="#059669" stroke-width="2" stroke-dasharray="4 3"/>'+
    '<text x="'+lx.toFixed(1)+'" y="'+(mt+10)+'" fill="#059669" font-size="11" font-weight="700" text-anchor="middle">85%: '+Math.round(p85)+'</text>';
  const axis='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
    '<text x="'+ml+'" y="'+(H-8)+'" fill="var(--hint)" font-size="10">'+Math.round(min)+'</text>'+
    '<text x="'+(ml+pw)+'" y="'+(H-8)+'" fill="var(--hint)" font-size="10" text-anchor="end">'+Math.round(max)+'</text>'+
    '<text x="'+(ml+pw/2)+'" y="'+(H-8)+'" fill="var(--hint)" font-size="10" text-anchor="middle">'+flowMetricNoun()+' delivered →</text>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+bars+marker+axis+'</svg>'+
    '<div class="fa-chart-legend"><span><span class="fa-leg-dot" style="background:#C7D2FE"></span>Outcome frequency</span>'+
    '<span><span class="fa-leg-line" style="background:#059669"></span>85% Safe Bet</span></div>'+flowExportBtn('monte-carlo-forecast')+'</div>';
}
function flowBurnupSVG(samples, target, split, maxK){
  const per=flowSimBurnup(samples, FLOW_TRIALS, maxK);
  const mean=flowStats(samples).mean, f=split/100;
  const creepEnd=target+mean*f*maxK;
  const topLine=flowPct(per[maxK-1], 50);            // most optimistic delivered line end
  const maxY=Math.max(target, creepEnd, topLine)*1.08 || 1;
  const W=720,H=300, ml=46,mr=14,mt=14,mb=30, pw=W-ml-mr, ph=H-mt-mb;
  const X=k=>ml+(k/maxK)*pw;
  const Y=v=>mt+ph-(v/maxY)*ph;
  // grid + axes
  let svg='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
          '<line x1="'+ml+'" y1="'+mt+'" x2="'+ml+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>';
  // y labels
  svg+='<text x="'+(ml-6)+'" y="'+(mt+4)+'" fill="var(--hint)" font-size="10" text-anchor="end">'+Math.round(maxY)+'</text>'+
       '<text x="'+(ml-6)+'" y="'+(mt+ph)+'" fill="var(--hint)" font-size="10" text-anchor="end">0</text>';
  // x labels
  const step=maxK<=12?1:Math.ceil(maxK/12);
  for(let k=0;k<=maxK;k+=step){ svg+='<text x="'+X(k).toFixed(1)+'" y="'+(H-10)+'" fill="var(--hint)" font-size="10" text-anchor="middle">'+k+'</text>'; }
  // scope target
  svg+='<line x1="'+ml+'" y1="'+Y(target).toFixed(1)+'" x2="'+(ml+pw)+'" y2="'+Y(target).toFixed(1)+'" stroke="#9CA3AF" stroke-width="1.5" stroke-dasharray="6 4"/>'+
       '<text x="'+(ml+pw)+'" y="'+(Y(target)-4).toFixed(1)+'" fill="var(--muted)" font-size="10" text-anchor="end">Scope '+target+'</text>';
  if(f>0){
    svg+='<line x1="'+X(0)+'" y1="'+Y(target).toFixed(1)+'" x2="'+X(maxK).toFixed(1)+'" y2="'+Y(creepEnd).toFixed(1)+'" stroke="#B45309" stroke-width="1.5" stroke-dasharray="2 3"/>'+
         '<text x="'+X(maxK).toFixed(1)+'" y="'+(Y(creepEnd)-4).toFixed(1)+'" fill="var(--amber)" font-size="10" text-anchor="end">+creep</text>';
  }
  // confidence lines (k=0 anchored at origin, X(0)=ml)
  FLOW_CONF.forEach(c=>{
    const pts=[];
    for(let k=0;k<=maxK;k++){ const v = k===0 ? 0 : flowPct(per[k-1], 100-c.p); pts.push(X(k).toFixed(1)+','+Y(v).toFixed(1)); }
    svg+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+c.col+'" stroke-width="'+(c.p===85?3:1.5)+'" opacity="'+(c.p===85?1:.85)+'"/>';
  });
  const legend='<div class="fa-chart-legend">'+FLOW_CONF.map(c=>'<span><span class="fa-leg-line" style="background:'+c.col+'"></span>'+c.p+'%</span>').join('')+
    '<span><span class="fa-leg-line" style="background:#9CA3AF"></span>Scope</span></div>';
  return '<div class="fa-chart"><div style="font-size:11px;color:var(--muted);margin-bottom:6px">Cumulative delivery by '+flowPeriodNoun()+' (where each line crosses Scope = forecast finish)</div>'+
    '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+svg+'</svg>'+legend+flowExportBtn('monte-carlo-burnup')+'</div>';
}

// ── COMMITMENT TAB INTEGRATION ─────────────────────────────────
// Surfaces the 85% "Safe Bet" next-sprint forecast inside Section 3.
function flowUpdateRecForecast(){
  const host=q('#rec-mc'); if(!host) return;
  const sm=flowVelocitySamples('points');   // points to align with SP-based commitment
  if(!sm.samples.length || sm.samples.length<3){ host.innerHTML=''; return; }
  const totals=flowSimHowMany(sm.samples, 1, FLOW_TRIALS);
  const safe=Math.round(flowPct(totals,15));   // 85% chance of at least this in 1 sprint
  const stretch=Math.round(flowPct(totals,50)); // coin-flip
  host.innerHTML='<div class="fa-warn sky" style="margin-top:10px">🎲 <span><strong>Monte Carlo forecast</strong> (from '+esc(sm.source)+'): '+
    '85% confident in <strong>'+safe+' pts</strong> next '+flowPeriodNoun()+', 50/50 stretch to <strong>'+stretch+' pts</strong>. '+
    '<span style="color:var(--muted)">See the Analytics tab to adjust.</span></span></div>';
}

// ════════════════════════════════════════════════════════════════
// DELIVERY TIME & PREDICTABILITY  -  Checkpoint 2A
// Lead time (created→done), cycle time (started→done), SLE, histograms
// ════════════════════════════════════════════════════════════════
function flowDaysNoun(){ return flowSettings().periodCalc==='work'?'work days':'calendar days'; }
// Day difference between two dates under the current Period Calc setting.
function flowDayDiff(a, b, calc){
  if(!a||!b) return null;
  const A=flowStartOfDay(a), B=flowStartOfDay(b);
  if(B<A) return null;
  if(calc==='calendar') return Math.round((B-A)/86400000);
  let d=new Date(A), n=0;
  while(d<B){ const dow=d.getDay(); if(dow!==0&&dow!==6) n++; d.setDate(d.getDate()+1); }
  return n;
}
// Per-item lead/cycle durations for every completed item.
function flowDurations(items){
  const st=flowSettings();
  return (items||flowItems()).filter(i=>i.completed).map(i=>{
    const c=flowParseISO(i.created), s=flowParseISO(i.started), e=flowParseISO(i.completed);
    let lead=null, cycle=null;
    if(c&&e){ const d=flowDayDiff(c,e,st.periodCalc); if(d!=null) lead = d===0?st.sameDayValue:d; }
    if(s&&e){ const d=flowDayDiff(s,e,st.periodCalc); if(d!=null) cycle = d===0?st.sameDayValue:d; }
    return {item:i, lead, cycle, completed:e};
  });
}
function flowAllDurations(){ return flowDurations(flowAllItems()); }
function flowSetSle(v){ flowSlePct=Math.max(1,Math.min(99,+v||85)); flowRenderGroupPred(); flowRenderKPI(); }
function flowSetBucket(v){ flowDurBucket=Math.max(1,+v||5); flowRenderGroupPred(); }

// ── PREDICTABILITY group ───────────────────────────────────────
// Pearson correlation coefficient between two equal-length numeric arrays.
function flowPearson(xs,ys){ const n=xs.length; if(n<2) return null;
  const mx=xs.reduce((a,b)=>a+b,0)/n, my=ys.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0,syy=0; for(let i=0;i<n;i++){ const dx=xs[i]-mx, dy=ys[i]-my; sxy+=dx*dy; sxx+=dx*dx; syy+=dy*dy; }
  const d=Math.sqrt(sxx*syy); return d? sxy/d : null; }
// Scatter of story points (x) vs cycle time (y), with the average cycle per estimate overlaid.
function flowCycVsPtsSVG(pts, color){
  if(!pts.length) return '<div class="fa-sec-hint">No completed items have both a story-point estimate and a start date (needed for cycle time).</div>';
  const W=680,H=260, PL=46, PR=14, PT=14, PB=36, iw=W-PL-PR, ih=H-PT-PB;
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const xMax=Math.max(...xs)||1;
  const yArr=ys.slice().sort((a,b)=>a-b), yCap=flowPct(yArr,95)||Math.max(...ys), yMax=Math.max(1, yCap*1.1), capped=Math.max(...ys)>yMax;
  const xScale=v=>PL+(v/xMax)*iw, yScale=v=>PT+ih-(Math.min(v,yMax)/yMax)*ih;
  let axis='<line x1="'+PL+'" y1="'+(PT+ih)+'" x2="'+(PL+iw)+'" y2="'+(PT+ih)+'" stroke="var(--border-2)"/>'+
           '<line x1="'+PL+'" y1="'+PT+'" x2="'+PL+'" y2="'+(PT+ih)+'" stroke="var(--border-2)"/>';
  for(let g=0;g<=4;g++){ const v=yMax*g/4, y=yScale(v); axis+='<line x1="'+PL+'" y1="'+y.toFixed(1)+'" x2="'+(PL+iw)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-dasharray="2 3"/><text x="'+(PL-6)+'" y="'+(y+3).toFixed(1)+'" text-anchor="end" font-size="9" fill="var(--muted)">'+Math.round(v)+'</text>'; }
  [...new Set(xs)].sort((a,b)=>a-b).forEach(v=>{ axis+='<text x="'+xScale(v).toFixed(1)+'" y="'+(PT+ih+15)+'" text-anchor="middle" font-size="9" fill="var(--muted)">'+v+'</text>'; });
  const byPt={}; pts.forEach(p=>{ (byPt[p.x]=byPt[p.x]||[]).push(p.y); });
  const avgPts=Object.keys(byPt).map(k=>({x:+k,y:flowStats(byPt[k]).mean})).sort((a,b)=>a.x-b.x);
  const avgLine=avgPts.length>=2? '<polyline points="'+avgPts.map(a=>xScale(a.x).toFixed(1)+','+yScale(a.y).toFixed(1)).join(' ')+'" fill="none" stroke="#059669" stroke-width="2"/>':'';
  const avgDots=avgPts.map(a=>'<circle cx="'+xScale(a.x).toFixed(1)+'" cy="'+yScale(a.y).toFixed(1)+'" r="3.5" fill="#059669"/>').join('');
  const dots=pts.map(p=>{ const jx=(((p.id||'').length%5)-2)*1.3; return '<circle cx="'+(xScale(p.x)+jx).toFixed(1)+'" cy="'+yScale(p.y).toFixed(1)+'" r="3" fill="'+color+'" fill-opacity="0.5"><title>'+esc(p.id||'item')+': '+p.x+' pts, '+Math.round(p.y)+' '+flowDaysNoun()+'</title></circle>'; }).join('');
  const labels='<text x="'+(PL+iw/2).toFixed(1)+'" y="'+(H-5)+'" text-anchor="middle" font-size="10" fill="var(--muted)">Story points</text>'+
    '<text transform="translate(12,'+(PT+ih/2).toFixed(1)+') rotate(-90)" text-anchor="middle" font-size="10" fill="var(--muted)">Cycle time ('+flowDaysNoun()+')</text>';
  const legend='<div class="fa-chart-legend"><span><span class="fa-leg-dot" style="background:'+color+'"></span>'+pts.length+' items</span><span><span class="fa-leg-line" style="background:#059669"></span>Avg cycle per estimate</span>'+(capped?'<span class="fa-sec-hint" style="margin:0">outliers above P95 clamped to top</span>':'')+'</div>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+axis+dots+avgLine+avgDots+labels+'</svg>'+legend+flowExportBtn('cycle-vs-story-points')+'</div>';
}
function flowRenderGroupPred(){
  const host=q('#fa-grp-pred'); if(!host) return;
  const durs=flowDurations();
  const leads=durs.map(d=>d.lead).filter(v=>v!=null).sort((a,b)=>a-b);
  const cycles=durs.map(d=>d.cycle).filter(v=>v!=null).sort((a,b)=>a-b);
  if(!leads.length){ host.innerHTML='<div class="fa-sec-hint">Import completed items with dates to see predictability charts.</div>'; return; }
  const dn=flowDaysNoun();
  const periods=flowByPeriod(), labels=periods.map(p=>p.label);
  const leadAvg=periods.map(p=>p.leads.length?Math.round(flowStats(p.leads).mean*10)/10:null);
  const cycleAvg=periods.map(p=>p.cycles.length?Math.round(flowStats(p.cycles).mean*10)/10:null);
  const covVals=periods.map(p=>p.leads.length>1?Math.round(flowStats(p.leads).cov*1000)/10:null);
  const leadPts=durs.filter(d=>d.lead!=null&&d.completed).map(d=>({t:+d.completed,y:d.lead,id:d.item.id}));
  const cyclePts=durs.filter(d=>d.cycle!=null&&d.completed).map(d=>({t:+d.completed,y:d.cycle,id:d.item.id}));
  const medLead=flowPct(leads,50), p85Lead=flowPct(leads,85), sleLead=flowPct(leads,flowSlePct);

  let html='';
  // controls (SLE percentile + histogram bucket)
  html+='<div class="fa-mc-controls" style="margin-bottom:14px">'+
    '<div class="fi"><label class="fl">SLE percentile</label><input type="number" min="1" max="99" value="'+flowSlePct+'" onchange="flowSetSle(this.value)"></div>'+
    '<div class="fi"><label class="fl">Histogram bucket ('+dn+')</label><input type="number" min="1" value="'+flowDurBucket+'" onchange="flowSetBucket(this.value)"></div>'+
  '</div>';

  // Lead time (avg)
  html+=flowChartRow({title:'Lead time (avg)', subtitle:'Created to done, avg per '+flowPeriodNoun()+' ('+dn+')',
    chart:flowLineSVG(labels,[{label:'Lead time',color:'#4F46E5',vals:leadAvg}],{id:'lead',controls:true,defTrend:'linear'}),
    benchKey:'medianLead', value:medLead, valueLabel:Math.round(medLead)+' '+dn,
    insight:'Median '+Math.round(medLead)+' '+dn+', P85 '+Math.round(p85Lead)+' '+dn+' across '+leads.length+' items.'});

  // Cycle time (avg)
  if(cycles.length){
    const medCycle=flowPct(cycles,50), p85Cycle=flowPct(cycles,85);
    html+=flowChartRow({title:'Cycle time (avg)', subtitle:'Started to done, avg per '+flowPeriodNoun()+' ('+dn+')',
      chart:flowLineSVG(labels,[{label:'Cycle time',color:'#0284C7',vals:cycleAvg}],{id:'cycle',controls:true,defTrend:'linear'}),
      benchKey:'medianCycle', value:medCycle, valueLabel:Math.round(medCycle)+' '+dn,
      insight:'Median '+Math.round(medCycle)+' '+dn+', P85 '+Math.round(p85Cycle)+' '+dn+'.'});
  } else html+=flowChartRow({title:'Cycle time (avg)', subtitle:'Started to done',
    chart:'<div class="fa-warn amber"><span>⚠ Needs a <strong>Start date</strong> per item.</span></div>', benchKey:'medianCycle', value:null});

  // Lead time histogram
  html+=flowChartRow({title:'Lead time histogram', subtitle:'Distribution of completed items ('+dn+')',
    chart:flowDurHist(leads, flowDurBucket, '#C7D2FE', sleLead, '#4F46E5'), benchKey:'leadHist', value:null,
    insight:flowSlePct+'% finish within '+Math.round(sleLead)+' '+dn+'. A long right tail means unpredictable outliers.'});

  // Cycle time histogram
  if(cycles.length) html+=flowChartRow({title:'Cycle time histogram', subtitle:'Distribution of active work time ('+dn+')',
    chart:flowDurHist(cycles, flowDurBucket, '#BAE6FD', flowPct(cycles,flowSlePct), '#0284C7'), benchKey:'cycleHist', value:null,
    insight:'A tight cluster means predictable execution; a wide spread means variable.'});

  // Distribution shape (bimodal detection)
  const kdeObj=flowKde(leads), peaks=kdeObj?flowPeaks(kdeObj):[];
  const bimodal=peaks.length>=2;
  html+=flowChartRow({title:'Distribution shape', subtitle:'Smoothed lead-time density (bimodal detection)',
    chart:flowKdeSVG(leads,'#4F46E5'), benchKey:'distShape', value:null,
    insight: bimodal
      ? ('Bimodal - two clusters near '+peaks.slice(0,2).map(p=>Math.round(p.x)).join(' and ')+' '+dn+'. The median is misleading; two kinds of work may be mixed.')
      : ('Single peak near '+Math.round(peaks[0]?peaks[0].x:flowPct(leads,50))+' '+dn+' - the median is representative.')});

  // SLE
  html+=flowChartRow({title:'Service Level Expectation (SLE)', subtitle:'Your data-backed delivery promise',
    chart:'<div class="fa-summary">'+
      '<div class="fa-scard"><div class="fa-scard-lbl">SLE ('+flowSlePct+'%)</div><div class="fa-scard-val">'+Math.round(sleLead)+' '+dn+'</div><div class="fa-scard-sub">lead time</div></div>'+
      '<div class="fa-scard"><div class="fa-scard-lbl">Median</div><div class="fa-scard-val">'+Math.round(medLead)+' '+dn+'</div></div>'+
      '<div class="fa-scard"><div class="fa-scard-lbl">P85</div><div class="fa-scard-val">'+Math.round(p85Lead)+' '+dn+'</div></div></div>',
    benchKey:'sle', value:null,
    insight:'Commit to stakeholders: "'+flowSlePct+'% of items finish within '+Math.round(sleLead)+' '+dn+'."'});

  // SLE attainment over time
  const sleTarget=sleLead;
  const attain=periods.map(p=>p.leads.length?Math.round(p.leads.filter(v=>v<=sleTarget).length/p.leads.length*100):null);
  const overallAttain=Math.round(leads.filter(v=>v<=sleTarget).length/leads.length*100);
  html+=flowChartRow({title:'SLE attainment over time', subtitle:'% meeting the '+Math.round(sleTarget)+' '+dn+' SLE, per '+flowPeriodNoun(),
    chart:flowLineSVG(labels,[{label:'Attainment %',color:'#059669',vals:attain}],{id:'sleattain',controls:true,pct:true,yMax:100,bands:[{from:flowSlePct,to:100,color:'#16A34A'}]}),
    benchKey:'sleAttain', value:overallAttain, valueLabel:overallAttain+'%',
    insight:'Overall '+overallAttain+'% finish within the SLE. The green band marks your '+flowSlePct+'% commitment line.'});

  // CoV trend
  const covMax=Math.max(100, ...covVals.filter(v=>v!=null))*1.05;
  html+=flowChartRow({title:'Lead-time CoV trend', subtitle:'Variability over time (lower is steadier)',
    chart:flowLineSVG(labels,[{label:'CoV %',color:'#7C3AED',vals:covVals}],{id:'cov',controls:true,pct:true,yMax:covMax,bands:[{from:0,to:50,color:'#16A34A'},{from:50,to:75,color:'#B45309'},{from:75,to:covMax,color:'#DC2626'}]}),
    benchKey:'ltCov', value:Math.round(flowStats(leads).cov*1000)/10, valueLabel:Math.round(flowStats(leads).cov*100)+'%',
    insight:'Bands: Excellent under 50%, Good 50-75%, Needs attention over 75%.'});

  // Lead time scatter
  html+=flowChartRow({title:'Lead time scatterplot', subtitle:'Each item by completion date; drag to zoom',
    chart:flowScatterSVG(leadPts,'lead','#4F46E5'), benchKey:'ltScatter', value:null,
    insight:'P50 '+Math.round(flowPct(leads,50))+' '+dn+', P85 '+Math.round(p85Lead)+' '+dn+'. Dots above P85 are outliers.'});

  // Cycle time scatter
  if(cyclePts.length) html+=flowChartRow({title:'Cycle time scatterplot', subtitle:'Each item by completion date; drag to zoom',
    chart:flowScatterSVG(cyclePts,'cycle','#0284C7'), benchKey:'ctScatter', value:null,
    insight:'Use this to spot items that stalled once work began.'});

  // Cycle time vs Story points (does the estimate predict actual time?)
  const cvp=durs.filter(d=>d.cycle!=null && d.item && (+d.item.points>0)).map(d=>({x:+d.item.points, y:d.cycle, id:d.item.id}));
  if(cvp.length>=2){
    const r=flowPearson(cvp.map(p=>p.x), cvp.map(p=>p.y));
    const rAbs=r==null?0:Math.abs(r);
    const strength=rAbs<0.2?'almost no':rAbs<0.4?'a weak':rAbs<0.6?'a moderate':rAbs<0.8?'a strong':'a very strong';
    const dir=(r||0)>=0?'positive':'negative';
    html+=flowChartRow({title:'Cycle time vs Story points', subtitle:'Does the estimate predict how long work actually takes?',
      chart:flowCycVsPtsSVG(cvp,'#0284C7'), benchKey:'cycVsPts', value:null,
      insight:'Correlation r = '+(r==null?'n/a':(Math.round(r*100)/100))+' ('+strength+' '+dir+' link) across '+cvp.length+' estimated items. '+
        (rAbs<0.4?'Story points barely predict cycle time here, so estimates are a weak time forecast; lean on throughput and cycle-time forecasting instead.':'Higher estimates do track longer cycle times, so points carry real signal for forecasting.')});
  } else html+=flowChartRow({title:'Cycle time vs Story points', subtitle:'Does the estimate predict how long work actually takes?',
    chart:'<div class="fa-sec-hint">Needs at least two completed items that have both a story-point estimate and a start date (for cycle time).</div>', benchKey:'cycVsPts', value:null});

  host.innerHTML=html;
}
// Fixed-width day-bucket histogram with an SLE marker line.
function flowDurHist(values, bucket, barColor, sleVal, sleColor){
  const max=Math.max(...values);
  const nB=Math.max(1, Math.ceil((max+0.0001)/bucket));
  const bins=new Array(nB).fill(0);
  values.forEach(v=>{ let b=Math.floor(v/bucket); if(b>=nB)b=nB-1; if(b<0)b=0; bins[b]++; });
  const maxC=Math.max(...bins)||1;
  const W=720,H=240, ml=40,mr=12,mt=14,mb=34, pw=W-ml-mr, ph=H-mt-mb;
  const barW=pw/nB;
  const total=values.length;
  let bars='', labels='';
  bins.forEach((c,i)=>{
    const bx=ml+i*barW, bh=(c/maxC)*ph, by=mt+ph-bh;
    bars+='<rect x="'+(bx+1).toFixed(1)+'" y="'+by.toFixed(1)+'" width="'+(barW-2).toFixed(1)+'" height="'+bh.toFixed(1)+
      '" rx="2" fill="'+barColor+'"><title>'+(i*bucket)+'-'+((i+1)*bucket)+' '+flowDaysNoun()+': '+c+' items ('+Math.round(c/total*100)+'%)</title></rect>';
    if(c>0) labels+='<text x="'+(bx+barW/2).toFixed(1)+'" y="'+(by-4).toFixed(1)+'" fill="var(--muted)" font-size="9" text-anchor="middle">'+c+'</text>';
  });
  // x-axis boundary labels (every few buckets)
  const step=nB<=10?1:Math.ceil(nB/10);
  let xlabels='';
  for(let i=0;i<=nB;i+=step){ xlabels+='<text x="'+(ml+i*barW).toFixed(1)+'" y="'+(H-12)+'" fill="var(--hint)" font-size="9" text-anchor="middle">'+(i*bucket)+'</text>'; }
  // SLE marker
  const sx=ml+Math.min(pw, (sleVal/(nB*bucket))*pw);
  const marker='<line x1="'+sx.toFixed(1)+'" y1="'+mt+'" x2="'+sx.toFixed(1)+'" y2="'+(mt+ph)+'" stroke="'+sleColor+'" stroke-width="2" stroke-dasharray="4 3"/>'+
    '<text x="'+sx.toFixed(1)+'" y="'+(mt-2)+'" fill="'+sleColor+'" font-size="10" font-weight="700" text-anchor="middle">'+flowSlePct+'%: '+Math.round(sleVal)+'</text>';
  const axis='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
    '<text x="'+(ml+pw)+'" y="'+(H-2)+'" fill="var(--hint)" font-size="9" text-anchor="end">'+flowDaysNoun()+' →</text>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+bars+labels+xlabels+marker+axis+'</svg></div>';
}

// ════════════════════════════════════════════════════════════════
// THROUGHPUT & QUALITY  -  Checkpoint 3A
// Net flow, work-type distribution, defect trend
// ════════════════════════════════════════════════════════════════
const FLOW_TYPE_COLORS = {Story:'#059669', Bug:'#DC2626', Task:'#0284C7', Epic:'#7C3AED', Other:'#9CA3AF'};
function flowTypeColor(t){ return FLOW_TYPE_COLORS[t]||FLOW_TYPE_COLORS.Other; }

// Periods spanning both created and completed, with type + bug breakdown of completed.
function flowThroughputPeriods(){
  const st=flowSettings(), items=flowItems(), map={};
  const touch=d=>{ const p=flowPeriodOf(d,st); return map[p.key]||(map[p.key]={key:p.key,label:p.label,start:+p.start,created:0,completed:0,types:{},bugs:0}); };
  items.forEach(i=>{
    const cd=flowParseISO(i.created), ed=flowParseISO(i.completed);
    if(cd) touch(cd).created++;
    if(ed){ const g=touch(ed); g.completed++; const t=flowNormType(i.type); g.types[t]=(g.types[t]||0)+1; if(t==='Bug') g.bugs++; }
  });
  return Object.values(map).sort((a,b)=>a.start-b.start);
}

// ── FLOW group ─────────────────────────────────────────────────
function flowRenderGroupFlow(){
  const host=q('#fa-grp-flow'); if(!host) return;
  const items=flowItems();
  if(!items.filter(i=>i.completed).length){ host.innerHTML='<div class="fa-sec-hint">Import completed items to see flow charts.</div>'; return; }
  const P=flowThroughputPeriods(), labels=P.map(p=>p.label);
  const durs=flowDurations();
  let html='';

  // Throughput trend
  const tp=P.map(p=>p.completed);
  const tpCovVal=Math.round(flowStats(tp).cov*1000)/10;
  html+=flowChartRow({title:'Throughput trend', subtitle:'Items completed per '+flowPeriodNoun(),
    chart:flowLineSVG(labels,[{label:'Completed',color:'#4F46E5',vals:tp}],{id:'tp',controls:true,defTrend:'linear'}),
    benchKey:'tpCov', value:tpCovVal, valueLabel:tpCovVal+'% CoV',
    insight:'Averaging '+Math.round(flowStats(tp).mean)+' items per '+flowPeriodNoun()+' over '+tp.length+' '+flowPeriodNoun(true)+'.'});

  // Net flow
  const net=P.map(p=>p.completed-p.created), cumNet=net.reduce((s,v)=>s+v,0);
  html+=flowChartRow({title:'Net flow', subtitle:'Completed minus created per '+flowPeriodNoun(),
    chart:flowBarSVG(labels,net,{posColor:'#16A34A',negColor:'#DC2626'}),
    benchKey:'netFlow', value:null,
    insight: cumNet>0?('Backlog shrinking by '+cumNet+' over this window.'):cumNet<0?('Backlog growing by '+Math.abs(cumNet)+' - watch intake.'):'Balanced intake and delivery.'});

  // Cumulative Flow Diagram (3-band)
  const cfd=flowCfdData();
  if(cfd){
    const cfdSeries=[{label:'Done',color:'#16A34A',vals:cfd.done}];
    if(flowCfdShowWip) cfdSeries.push({label:'In progress',color:'#F59E0B',vals:cfd.inp});
    cfdSeries.push({label:'To do',color:'#94A3B8',vals:cfd.todo});
    const curWip=cfd.inp[cfd.inp.length-1];
    html+=flowChartRow({title:'Cumulative flow (CFD)', subtitle:'Created / in progress / done over time',
      chart:flowStackedAreaSVG(cfd.labels, cfdSeries)+
        '<div class="fa-ctrl-chips"><span class="fa-ctrl-chip" style="cursor:pointer" onclick="flowToggleCfdWip()">'+(flowCfdShowWip?'✓ ':'')+'Show in-progress band</span></div>',
      benchKey:'cfd', value:null,
      insight:'Current work in progress: '+curWip+' item'+(curWip===1?'':'s')+'. The in-progress band is your WIP; a widening band means a bottleneck.'});

    // Flow bottleneck analysis (staged open work)
    const bn=flowBottleneck(cfd);
    const anyStart=flowItems().some(i=>i.started);
    const bnSeries = anyStart
      ? [{label:'Queued',color:'#94A3B8',vals:cfd.todo},{label:'In progress',color:'#F59E0B',vals:cfd.inp}]
      : [{label:'Open work',color:'#94A3B8',vals:cfd.todo.map((v,i)=>v+cfd.inp[i])}];
    html+=flowChartRow({title:'Flow bottleneck analysis', subtitle:'Where open work accumulates over time',
      chart:flowStackedAreaSVG(cfd.labels, bnSeries), benchKey:'bottleneck', value:null,
      insight: (bn?('Detected constraint: '+bn.location+'. '):'')+(anyStart?'Queued = created but not started; In progress = started but not done.':'Map a Start date to split queued vs in-progress work.')});
  }

  // Flow efficiency
  const both=durs.filter(d=>d.lead!=null&&d.cycle!=null);
  if(both.length){
    const feOverall=(both.reduce((s,d)=>s+d.cycle,0)/both.reduce((s,d)=>s+d.lead,0))*100;
    const periods=flowByPeriod();
    const feVals=periods.map(p=>p.pairLead>0?Math.round(p.pairCycle/p.pairLead*1000)/10:null);
    html+=flowChartRow({title:'Flow efficiency', subtitle:'Active work ÷ total lead time, per '+flowPeriodNoun(),
      chart:flowLineSVG(periods.map(p=>p.label),[{label:'Flow eff %',color:'#059669',vals:feVals}],{id:'fe',controls:true,pct:true,yMax:100,bands:[{from:15,to:40,color:'#0284C7'}]}),
      benchKey:'flowEff', value:Math.round(feOverall), valueLabel:Math.round(feOverall)+'%',
      insight:both.length+' items have start and done dates. Typical teams sit between 15% and 40%.'});
  } else {
    html+=flowChartRow({title:'Flow efficiency', subtitle:'Active work ÷ total lead time',
      chart:'<div class="fa-warn amber"><span>⚠ Needs a <strong>Start date</strong> per item to compute.</span></div>', benchKey:'flowEff', value:null});
  }

  // Work type distribution
  const present=['Story','Bug','Task','Epic','Other'].filter(k=>P.some(p=>p.types[k]));
  const series=present.map(k=>({label:k, color:flowTypeColor(k), vals:P.map(p=>p.types[k]||0)}));
  html+=flowChartRow({title:'Work type distribution', subtitle:'Completed by type per '+flowPeriodNoun(),
    chart:flowStackedAreaSVG(labels, series), benchKey:'workType', value:null,
    insight:'Mix: '+present.map(k=>k+' '+P.reduce((s,p)=>s+(p.types[k]||0),0)).join(' · ')+'.'});

  host.innerHTML=html;
}

// Signed bar chart with a zero baseline (positive up, negative down).
function flowBarSVG(labels, vals, opts){
  opts=opts||{};
  const W=720,H=230, ml=44,mr=14,mt=16,mb=40, pw=W-ml-mr, ph=H-mt-mb, n=vals.length||1;
  const maxAbs=Math.max(1, ...vals.map(v=>Math.abs(v)));
  const anyNeg=vals.some(v=>v<0);
  const z=anyNeg?mt+ph/2:mt+ph;
  const scale=(anyNeg?ph/2:ph)/maxAbs;
  const bw=pw/n;
  let svg='<line x1="'+ml+'" y1="'+z.toFixed(1)+'" x2="'+(ml+pw)+'" y2="'+z.toFixed(1)+'" stroke="var(--border-2)"/>';
  vals.forEach((v,i)=>{
    const bx=ml+i*bw+bw*0.15, bwi=bw*0.7, h=Math.abs(v)*scale, by=v>=0?z-h:z;
    const col=v>=0?(opts.posColor||'#4F46E5'):(opts.negColor||'#DC2626');
    svg+='<rect x="'+bx.toFixed(1)+'" y="'+by.toFixed(1)+'" width="'+bwi.toFixed(1)+'" height="'+Math.max(1,h).toFixed(1)+'" rx="2" fill="'+col+'"><title>'+esc(labels[i])+': '+(v>0?'+':'')+v+'</title></rect>';
  });
  const step=n<=8?1:Math.ceil(n/8);
  for(let i=0;i<n;i+=step){ svg+='<text x="'+(ml+i*bw+bw/2).toFixed(1)+'" y="'+(H-16)+'" fill="var(--hint)" font-size="9" text-anchor="middle">'+esc(labels[i])+'</text>'; }
  svg+='<text x="'+(ml-6)+'" y="'+(mt+8)+'" fill="var(--hint)" font-size="10" text-anchor="end">+'+Math.round(maxAbs)+'</text>';
  if(anyNeg) svg+='<text x="'+(ml-6)+'" y="'+(mt+ph)+'" fill="var(--hint)" font-size="10" text-anchor="end">−'+Math.round(maxAbs)+'</text>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+svg+'</svg></div>';
}

// Stacked area chart over categorical periods.
function flowStackedAreaSVG(labels, series){
  const W=720,H=250, ml=44,mr=14,mt=16,mb=42, pw=W-ml-mr, ph=H-mt-mb, n=labels.length;
  if(!n||!series.length) return '<div class="fa-sec-hint">No data.</div>';
  const totals=labels.map((_,i)=>series.reduce((s,se)=>s+(se.vals[i]||0),0));
  const yMax=Math.max(1, ...totals)*1.05;
  const X=i=> n<=1?ml+pw/2:ml+(i/(n-1))*pw;
  const Y=v=>mt+ph-(v/yMax)*ph;
  let svg='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
          '<line x1="'+ml+'" y1="'+mt+'" x2="'+ml+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
          '<text x="'+(ml-6)+'" y="'+(mt+4)+'" fill="var(--hint)" font-size="10" text-anchor="end">'+Math.round(yMax)+'</text>';
  const bottom=new Array(n).fill(0);
  series.forEach(se=>{
    const top=[], bot=[];
    for(let i=0;i<n;i++){ const c0=bottom[i], c1=c0+(se.vals[i]||0); top.push(X(i).toFixed(1)+','+Y(c1).toFixed(1)); bot.push(X(i).toFixed(1)+','+Y(c0).toFixed(1)); }
    svg+='<path d="M'+top.join(' L')+' L'+bot.reverse().join(' L')+' Z" fill="'+se.color+'" opacity="0.72"/>';
    for(let i=0;i<n;i++) bottom[i]+=(se.vals[i]||0);
  });
  const step=n<=8?1:Math.ceil(n/8);
  for(let i=0;i<n;i+=step){ svg+='<text x="'+X(i).toFixed(1)+'" y="'+(H-18)+'" fill="var(--hint)" font-size="9" text-anchor="middle">'+esc(labels[i])+'</text>'; }
  const legend='<div class="fa-chart-legend">'+series.map(se=>'<span><span class="fa-leg-dot" style="background:'+se.color+'"></span>'+esc(se.label)+'</span>').join('')+'</div>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+svg+'</svg>'+legend+'</div>';
}

// ════════════════════════════════════════════════════════════════
// FLOW DIAGNOSTICS  -  Checkpoint 2B
// Lead/cycle trend, CoV trend, flow efficiency, scatterplots (zoomable)
// ════════════════════════════════════════════════════════════════
// Group completed items by completion period; keep paired sums for flow efficiency.
function flowByPeriod(){
  const st=flowSettings(), durs=flowDurations(), groups={};
  durs.forEach(d=>{
    if(!d.completed) return;
    const p=flowPeriodOf(d.completed, st);
    const g=groups[p.key]||(groups[p.key]={key:p.key,label:p.label,start:+p.start,leads:[],cycles:[],pairLead:0,pairCycle:0});
    if(d.lead!=null) g.leads.push(d.lead);
    if(d.cycle!=null) g.cycles.push(d.cycle);
    if(d.lead!=null && d.cycle!=null){ g.pairLead+=d.lead; g.pairCycle+=d.cycle; }
  });
  return Object.values(groups).sort((a,b)=>a.start-b.start);
}

// ── WORK MANAGEMENT group ──────────────────────────────────────
function flowRenderGroupWork(){
  const host=q('#fa-grp-work'); if(!host) return;
  const items=flowItems();
  if(!items.length){ host.innerHTML='<div class="fa-sec-hint">Import items to see work-management charts.</div>'; return; }
  const dn=flowDaysNoun();
  let html='';

  // WIP trend
  const cfd=flowCfdData();
  if(cfd){
    const ll=flowLittlesLaw();
    const bands = ll!=null ? [{from:Math.max(0,ll-0.4),to:ll+0.4,color:'#0284C7'}] : [];
    const curWip=cfd.inp[cfd.inp.length-1];
    html+=flowChartRow({title:'WIP trend', subtitle:'Open (in-progress) items over time',
      chart:flowLineSVG(cfd.labels,[{label:'WIP',color:'#F59E0B',vals:cfd.inp}],{id:'wip',controls:true,bands}),
      benchKey:'wipTrend', value:null,
      insight:'Current WIP is '+curWip+'.'+(ll!=null?(' Little’s Law estimate for your throughput and cycle time is about '+ll+' (blue band).'):'')});
  }

  // WIP aging (overall)
  const z=flowAgeZones(), open=flowOpenItems();
  const zoneLegend='<div class="fa-zones"><span><span class="fa-zone-dot" style="background:var(--green)"></span>Healthy (≤P50 '+Math.round(z.p50)+dn+')</span>'+
    '<span><span class="fa-zone-dot" style="background:var(--amber)"></span>Warning (≤P85 '+Math.round(z.p85)+dn+')</span>'+
    '<span><span class="fa-zone-dot" style="background:var(--red)"></span>At risk (>P85)</span></div>';
  if(open.length){
    const rows=open.map(o=>({id:o.id, age:o.age, color:flowZoneColor(o.age,z)}));
    const nRisk=open.filter(o=>o.age>z.p85).length, nWarn=open.filter(o=>o.age>z.p50&&o.age<=z.p85).length;
    let tbl='<table class="fa-atbl"><thead><tr><th>Item</th><th>Type</th><th>Status</th><th class="num">Days open</th><th>Zone</th></tr></thead><tbody>'+
      open.map(o=>{ const col=flowZoneColor(o.age,z), zn=flowZoneName(o.age,z);
        return '<tr><td>'+esc(o.id||'-')+'</td><td>'+esc(o.type)+'</td><td>'+esc(o.status||'-')+'</td><td class="num">'+o.age+'</td>'+
          '<td><span class="fa-zone-pill" style="color:'+col+';background:var(--s2bg)">'+zn+'</span></td></tr>'; }).join('')+
      '</tbody></table>';
    html+=flowChartRow({title:'WIP aging', subtitle:'In-progress items by age vs your cycle-time percentiles',
      chart:zoneLegend+flowHBars(rows)+tbl, benchKey:'wipAging', value:null,
      insight:nRisk+' at risk (past P85), '+nWarn+' in warning, of '+open.length+' open item'+(open.length===1?'':'s')+'.'});

    // WIP aging by work type
    const byType={};
    open.forEach(o=>{ const t=o.type; (byType[t]=byType[t]||{Healthy:0,Warning:0,'At risk':0})[flowZoneName(o.age,z)]++; });
    let ttbl='<table class="fa-atbl"><thead><tr><th>Type</th><th class="num">Healthy</th><th class="num">Warning</th><th class="num">At risk</th></tr></thead><tbody>'+
      Object.keys(byType).sort((a,b)=>byType[b]['At risk']-byType[a]['At risk']).map(t=>{ const c=byType[t];
        return '<tr><td><span class="fa-pill '+flowTypeClass(t)+'">'+esc(t)+'</span></td>'+
          '<td class="num">'+c.Healthy+'</td><td class="num" style="color:var(--amber)">'+c.Warning+'</td><td class="num" style="color:var(--red)">'+c['At risk']+'</td></tr>'; }).join('')+
      '</tbody></table>';
    html+=flowChartRow({title:'WIP aging by work type', subtitle:'Where staleness concentrates',
      chart:ttbl, benchKey:'wipAging', value:null,
      insight:'Types sorted with the most at-risk items on top.'});
  } else {
    html+=flowChartRow({title:'WIP aging', subtitle:'In-progress items by age',
      chart:'<div class="fa-warn green"><span>✓ No items are currently in progress (started but not done).</span></div>',
      benchKey:'wipAging', value:null});
  }

  // Backlog aging
  const bl=flowBacklogItems();
  const thr=flowBacklogThr;
  const blControl='<div class="fa-mc-controls" style="margin-bottom:12px"><div class="fi"><label class="fl">Stale threshold ('+dn+')</label>'+
    '<input type="number" min="1" value="'+thr+'" onchange="flowSetBacklogThr(this.value)"></div></div>';
  if(bl.length){
    const blColor=a=>a>thr*2?'var(--red)':(a>thr?'var(--amber)':'var(--green)');
    const blName=a=>a>thr*2?'Stale':(a>thr?'Aging':'Fresh');
    const rows=bl.map(b=>({id:b.id, age:b.age, color:blColor(b.age)}));
    const nStale=bl.filter(b=>b.age>thr*2).length, nAging=bl.filter(b=>b.age>thr&&b.age<=thr*2).length;
    let tbl='<table class="fa-atbl"><thead><tr><th>Item</th><th>Type</th><th class="num">Age ('+dn+')</th><th>Zone</th></tr></thead><tbody>'+
      bl.map(b=>'<tr><td>'+esc(b.id||'-')+'</td><td>'+esc(b.type)+'</td><td class="num">'+b.age+'</td>'+
        '<td><span class="fa-zone-pill" style="color:'+blColor(b.age)+';background:var(--s2bg)">'+blName(b.age)+'</span></td></tr>').join('')+'</tbody></table>';
    html+=flowChartRow({title:'Backlog aging', subtitle:'Never-started items ranked by age',
      chart:blControl+flowHBars(rows)+tbl, benchKey:'backlogAging', value:null,
      insight:nStale+' stale (over '+(thr*2)+dn+'), '+nAging+' aging, of '+bl.length+' backlog item'+(bl.length===1?'':'s')+'. Consider grooming the stale ones.'});
  } else {
    html+=flowChartRow({title:'Backlog aging', subtitle:'Never-started items ranked by age',
      chart:blControl+'<div class="fa-warn green"><span>✓ No un-started backlog items.</span></div>', benchKey:'backlogAging', value:null});
  }

  // Defect trend
  const P=flowThroughputPeriods(), labels=P.map(p=>p.label);
  const total=P.map(p=>p.completed), bugs=P.map(p=>p.bugs);
  const totBugs=bugs.reduce((s,v)=>s+v,0), totDone=total.reduce((s,v)=>s+v,0);
  const defPct=totDone?Math.round(totBugs/totDone*100):0;
  html+=flowChartRow({title:'Defect trend', subtitle:'Bugs vs total throughput per '+flowPeriodNoun(),
    chart:flowLineSVG(labels,[{label:'Throughput',color:'#4F46E5',vals:total},{label:'Defects',color:'#DC2626',vals:bugs}],{id:'defect',controls:true}),
    benchKey:'defectRate', value:defPct, valueLabel:defPct+'%',
    insight:totBugs+' of '+totDone+' completed items were bugs.'});

  host.innerHTML=html;
}

// ── Per-chart controls: state, handlers, trend fitting ─────────
function flowGetCtl(id, defTrend){
  const c=flowChartCtl[id]||{};
  return {style:c.style||'line', labels:!!c.labels, trend:c.trend||defTrend||'none'};
}
function flowSetChartStyle(id,v){ (flowChartCtl[id]=flowChartCtl[id]||{}).style=v; flowRerenderCharts(); }
function flowToggleLabels(id){ const c=flowChartCtl[id]=flowChartCtl[id]||{}; c.labels=!c.labels; flowRerenderCharts(); }
function flowSetTrend(id,v){ (flowChartCtl[id]=flowChartCtl[id]||{}).trend=v; flowRerenderCharts(); }
function flowRerenderCharts(){ flowRenderGroupFlow(); flowRenderGroupPred(); flowRenderGroupWork(); }
function flowChartControls(id, ctl){
  const sty=(v,l)=>'<button class="fa-ctrl-chip'+(ctl.style===v?' on':'')+'" onclick="flowSetChartStyle(\''+id+'\',\''+v+'\')">'+l+'</button>';
  const topts=[['none','None'],['linear','Linear'],['exp','Exponential'],['poly','Polynomial'],['ma','Moving avg']]
    .map(o=>'<option value="'+o[0]+'"'+(ctl.trend===o[0]?' selected':'')+'>'+o[1]+'</option>').join('');
  return '<div class="fa-ctrl-chips">'+
    '<span class="fa-ctrl-lbl">Style</span>'+sty('line','Line')+sty('bar','Bar')+
    '<button class="fa-ctrl-chip'+(ctl.labels?' on':'')+'" onclick="flowToggleLabels(\''+id+'\')">Labels</button>'+
    '<span class="fa-ctrl-lbl">Trend</span><select onchange="flowSetTrend(\''+id+'\',this.value)">'+topts+'</select></div>';
}
function flowDet3(m){ return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1]) - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0]) + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]); }
function flowSolve3(A,B){ const d=flowDet3(A); if(Math.abs(d)<1e-9) return null; const c=[];
  for(let k=0;k<3;k++){ const M=A.map(r=>r.slice()); for(let i=0;i<3;i++) M[i][k]=B[i]; c.push(flowDet3(M)/d); } return c; }
function flowSampleCurve(x0,x1,fn){ const out=[], S=Math.max(2,Math.min(24,(x1-x0)+1||2)); for(let i=0;i<S;i++){ const x=x0+(x1-x0)*i/(S-1); out.push({x,y:fn(x)}); } return out; }
// Returns [{x,y}] points to draw a trendline of the given type, or null.
function flowTrendLine(v, type){
  const idx=[]; v.forEach((y,i)=>{ if(y!=null) idx.push(i); });
  if(idx.length<2) return null;
  const xs=idx, ys=idx.map(i=>v[i]), n=xs.length, avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
  if(type==='ma'){ const k=Math.min(3,n), out=[];
    for(let p=0;p<n;p++){ let a=0,c=0; for(let qq=Math.max(0,p-k+1);qq<=p;qq++){a+=ys[qq];c++;} out.push({x:xs[p],y:a/c}); } return out; }
  if(type==='linear'){ const xm=avg(xs),ym=avg(ys); let num=0,den=0;
    for(let i=0;i<n;i++){num+=(xs[i]-xm)*(ys[i]-ym);den+=(xs[i]-xm)*(xs[i]-xm);}
    const b=den?num/den:0, a=ym-b*xm; return flowSampleCurve(xs[0],xs[n-1],x=>a+b*x); }
  if(type==='exp'){ const px=[],py=[]; for(let i=0;i<n;i++){ if(ys[i]>0){px.push(xs[i]);py.push(Math.log(ys[i]));} }
    if(px.length<2) return null; const xm=avg(px),ym=avg(py); let num=0,den=0;
    for(let i=0;i<px.length;i++){num+=(px[i]-xm)*(py[i]-ym);den+=(px[i]-xm)*(px[i]-xm);}
    const B=den?num/den:0, A=ym-B*xm; return flowSampleCurve(xs[0],xs[n-1],x=>Math.exp(A+B*x)); }
  if(type==='poly'){ let Sx=0,Sx2=0,Sx3=0,Sx4=0,Sy=0,Sxy=0,Sx2y=0;
    for(let i=0;i<n;i++){ const x=xs[i],y=ys[i],x2=x*x; Sx+=x;Sx2+=x2;Sx3+=x2*x;Sx4+=x2*x2;Sy+=y;Sxy+=x*y;Sx2y+=x2*y; }
    const c=flowSolve3([[n,Sx,Sx2],[Sx,Sx2,Sx3],[Sx2,Sx3,Sx4]],[Sy,Sxy,Sx2y]); if(!c) return null;
    return flowSampleCurve(xs[0],xs[n-1],x=>c[0]+c[1]*x+c[2]*x*x); }
  return null;
}

// Generic multi-series line chart over categorical period labels.
function flowLineSVG(labels, series, opts){
  opts=opts||{};
  const W=720,H=250, ml=44,mr=14,mt=16,mb=42, pw=W-ml-mr, ph=H-mt-mb, n=labels.length;
  const flat=series.flatMap(s=>s.vals.filter(v=>v!=null));
  let yMax=opts.yMax || (flat.length?Math.max(...flat):1); yMax=yMax*1.1||1;
  const X=i=> n<=1 ? ml+pw/2 : ml+(i/(n-1))*pw;
  const Y=v=> mt+ph-(Math.min(v,yMax)/yMax)*ph;
  let svg='';
  (opts.bands||[]).forEach(b=>{ const y1=Y(Math.min(b.to,yMax)), y2=Y(Math.min(b.from,yMax));
    svg+='<rect x="'+ml+'" y="'+y1.toFixed(1)+'" width="'+pw+'" height="'+Math.max(0,y2-y1).toFixed(1)+'" fill="'+b.color+'" opacity="0.12"/>'; });
  svg+='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
       '<line x1="'+ml+'" y1="'+mt+'" x2="'+ml+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>';
  svg+='<text x="'+(ml-6)+'" y="'+(mt+4)+'" fill="var(--hint)" font-size="10" text-anchor="end">'+Math.round(yMax)+(opts.pct?'%':'')+'</text>'+
       '<text x="'+(ml-6)+'" y="'+(mt+ph)+'" fill="var(--hint)" font-size="10" text-anchor="end">0</text>';
  const step=n<=8?1:Math.ceil(n/8);
  for(let i=0;i<n;i+=step){ svg+='<text x="'+X(i).toFixed(1)+'" y="'+(H-18)+'" fill="var(--hint)" font-size="9" text-anchor="middle">'+esc(labels[i])+'</text>'; }
  const ctl = opts.controls ? flowGetCtl(opts.id, opts.defTrend) : {style:'line', labels:false, trend: opts.trend?'linear':'none'};
  const suf = opts.pct?'%':'';
  series.forEach((s,si)=>{
    if(ctl.style==='bar' && si===0){
      const bw=n>0?Math.max(4,(pw/n)*0.6):10;
      s.vals.forEach((v,i)=>{ if(v==null) return; const x=X(i), h=(Math.min(v,yMax)/yMax)*ph;
        svg+='<rect x="'+(x-bw/2).toFixed(1)+'" y="'+Y(v).toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+Math.max(1,h).toFixed(1)+'" rx="2" fill="'+s.color+'"><title>'+esc(labels[i])+': '+(Math.round(v*10)/10)+suf+'</title></rect>'; });
    } else {
      const pts=[];
      s.vals.forEach((v,i)=>{ if(v!=null) pts.push(X(i).toFixed(1)+','+Y(v).toFixed(1)); });
      if(pts.length>1) svg+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+s.color+'" stroke-width="2"/>';
      s.vals.forEach((v,i)=>{ if(v!=null) svg+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(v).toFixed(1)+'" r="3" fill="'+s.color+'"><title>'+esc(labels[i])+': '+(Math.round(v*10)/10)+suf+'</title></circle>'; });
    }
    if(ctl.labels){ s.vals.forEach((v,i)=>{ if(v!=null) svg+='<text x="'+X(i).toFixed(1)+'" y="'+(Y(v)-5).toFixed(1)+'" fill="var(--muted)" font-size="8.5" text-anchor="middle">'+(Math.round(v*10)/10)+suf+'</text>'; }); }
  });
  // trendline (multi-type) over the first series
  let trendDir='';
  if(ctl.trend && ctl.trend!=='none' && series[0]){
    const tl=flowTrendLine(series[0].vals, ctl.trend);
    if(tl && tl.length){
      const pts=tl.map(p=>X(p.x).toFixed(1)+','+Y(Math.max(0,p.y)).toFixed(1));
      svg+='<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+series[0].color+'" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.55"/>';
      trendDir=ctl.trend;
    }
  }
  const legend='<div class="fa-chart-legend">'+series.map(s=>'<span><span class="fa-leg-line" style="background:'+s.color+'"></span>'+esc(s.label)+'</span>').join('')+
    (trendDir?'<span><span class="fa-leg-line" style="background:'+series[0].color+';opacity:.55"></span>trend ('+esc(trendDir)+')</span>':'')+'</div>';
  const controls = opts.controls ? flowChartControls(opts.id, ctl) : '';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+svg+'</svg>'+legend+controls+'</div>';
}

// Scatterplot of completion-date (x) vs duration (y), with P50/85/95 lines and drag-to-zoom.
function flowScatterSVG(points, which, color){
  if(!points.length) return '<div class="fa-sec-hint">No data.</div>';
  const zoom=flowZoom[which];
  const allMin=Math.min(...points.map(p=>p.t)), allMax=Math.max(...points.map(p=>p.t));
  let dMin=zoom?zoom.min:allMin, dMax=zoom?zoom.max:allMax;
  if(dMax<=dMin) dMax=dMin+86400000;
  const vis=points.filter(p=>p.t>=dMin&&p.t<=dMax);
  const ys=vis.map(p=>p.y).sort((a,b)=>a-b);
  const p50=flowPct(ys,50), p85=flowPct(ys,85), p95=flowPct(ys,95);
  const yMax=(Math.max(...points.map(p=>p.y))*1.1)||1;
  const W=720,H=270, ml=44,mr=14,mt=16,mb=40, pw=W-ml-mr, ph=H-mt-mb;
  const X=t=>ml+((t-dMin)/(dMax-dMin))*pw;
  const Y=v=>mt+ph-(Math.min(v,yMax)/yMax)*ph;
  flowScatterGeo[which]={W,ml,pw,dMin,dMax};
  let svg='';
  [['50',p50,'#9CA3AF'],['85',p85,'#059669'],['95',p95,'#B45309']].forEach(a=>{
    svg+='<line x1="'+ml+'" y1="'+Y(a[1]).toFixed(1)+'" x2="'+(ml+pw)+'" y2="'+Y(a[1]).toFixed(1)+'" stroke="'+a[2]+'" stroke-width="1" stroke-dasharray="4 3" opacity="0.75"/>'+
      '<text x="'+(ml+pw)+'" y="'+(Y(a[1])-3).toFixed(1)+'" fill="'+a[2]+'" font-size="9" text-anchor="end">P'+a[0]+' '+Math.round(a[1])+'</text>';
  });
  svg+='<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>'+
       '<line x1="'+ml+'" y1="'+mt+'" x2="'+ml+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>';
  svg+='<text x="'+(ml-6)+'" y="'+(mt+4)+'" fill="var(--hint)" font-size="10" text-anchor="end">'+Math.round(yMax)+'</text>';
  [0,0.5,1].forEach(fr=>{ const t=dMin+fr*(dMax-dMin); svg+='<text x="'+X(t).toFixed(1)+'" y="'+(H-16)+'" fill="var(--hint)" font-size="9" text-anchor="'+(fr===0?'start':fr===1?'end':'middle')+'">'+flowFmtDate(new Date(t))+'</text>'; });
  vis.forEach(p=>{ svg+='<circle cx="'+X(p.t).toFixed(1)+'" cy="'+Y(p.y).toFixed(1)+'" r="3.5" fill="'+color+'" opacity="0.6"><title>'+esc(p.id||'')+': '+p.y+' '+flowDaysNoun()+'</title></circle>'; });
  // event annotations within the visible range
  flowAnnotations().forEach(an=>{ const ad=flowParseISO(an.date); if(!ad) return; const tt=+ad;
    if(tt>=dMin && tt<=dMax){ const axx=X(tt);
      svg+='<line x1="'+axx.toFixed(1)+'" y1="'+mt+'" x2="'+axx.toFixed(1)+'" y2="'+(mt+ph)+'" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>'+
        '<text x="'+axx.toFixed(1)+'" y="'+(mt-2)+'" fill="var(--muted)" font-size="8" text-anchor="middle">'+esc(String(an.label).slice(0,20))+'</text>'; } });
  svg+='<rect id="fa-sel-'+which+'" x="0" y="'+mt+'" width="0" height="'+ph+'" fill="#4F46E5" opacity="0.12" style="display:none"/>';
  const resetBtn=zoom?'<button class="btn btn-ghost btn-sm" style="padding:2px 8px" onclick="flowScatterReset(\''+which+'\')">Reset zoom</button>':'';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" style="cursor:crosshair" '+
    'onmousedown="flowScatterDown(event,\''+which+'\')" onmousemove="flowScatterMove(event,\''+which+'\')" onmouseup="flowScatterUp(event,\''+which+'\')" onmouseleave="flowScatterUp(event,\''+which+'\')">'+svg+'</svg>'+
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div class="fa-chart-legend"><span><span class="fa-leg-dot" style="background:'+color+'"></span>'+vis.length+' items</span><span><span class="fa-leg-line" style="background:#059669"></span>P85 '+Math.round(p85)+' '+flowDaysNoun()+'</span></div>'+resetBtn+'</div>'+
    '<div class="fa-set-note">Drag left-to-right across the plot to zoom into a date range.</div></div>';
}
function flowSvgX(evt, which){
  const svg=evt.currentTarget, rect=svg.getBoundingClientRect(), geo=flowScatterGeo[which];
  if(!geo||!rect.width) return null;
  return (evt.clientX-rect.left)/rect.width*geo.W;
}
function flowScatterDown(evt, which){
  const x=flowSvgX(evt,which); if(x==null) return;
  flowDrag={which, x0:x};
  const sel=document.getElementById('fa-sel-'+which);
  if(sel){ sel.style.display=''; sel.setAttribute('x', x); sel.setAttribute('width', 0); }
}
function flowScatterMove(evt, which){
  if(!flowDrag||flowDrag.which!==which) return;
  const x=flowSvgX(evt,which); if(x==null) return;
  const sel=document.getElementById('fa-sel-'+which); if(!sel) return;
  sel.setAttribute('x', Math.min(x,flowDrag.x0)); sel.setAttribute('width', Math.abs(x-flowDrag.x0));
}
function flowScatterUp(evt, which){
  if(!flowDrag||flowDrag.which!==which) return;
  const x=flowSvgX(evt,which), geo=flowScatterGeo[which], d=flowDrag;
  flowDrag=null;
  const sel=document.getElementById('fa-sel-'+which); if(sel) sel.style.display='none';
  if(x==null||!geo) return;
  const xa=Math.min(d.x0,x), xb=Math.max(d.x0,x);
  if(xb-xa < 8) return; // ignore clicks / tiny drags
  const toT=px=> geo.dMin + ((px-geo.ml)/geo.pw)*(geo.dMax-geo.dMin);
  const t1=Math.max(geo.dMin, toT(xa)), t2=Math.min(geo.dMax, toT(xb));
  flowZoom[which]={min:t1, max:t2};
  flowRenderGroupPred();
}
function flowScatterReset(which){ flowZoom[which]=null; flowRenderGroupPred(); }

// ════════════════════════════════════════════════════════════════
// WIP & AGING  -  Checkpoint V3-3
// Three-band CFD, WIP trend (Little's Law), WIP aging, backlog aging
// ════════════════════════════════════════════════════════════════
function flowNow(){ return new Date(); }
function flowPeriodDays(){
  const st=flowSettings(), m={weekly:7, biweekly:(st.sprintLength||2)*7, monthly:30, quarterly:91, yearly:365};
  return m[st.timeSpan]||14;
}
// Cumulative Created / In-progress / Done at a series of as-of dates.
function flowCfdData(){
  const items=flowItems(), ds=[];
  items.forEach(i=>{ [i.created,i.started,i.completed].forEach(x=>{ const d=flowParseISO(x); if(d) ds.push(+d); }); });
  if(!ds.length) return null;
  const now=+flowNow(), min=Math.min.apply(null,ds), max=Math.max.apply(null,ds.concat(now));
  const step=flowPeriodDays()*86400000, axis=[]; let cur=+flowStartOfDay(new Date(min));
  while(cur<=max && axis.length<160){ axis.push(cur); cur+=step; }
  if(axis[axis.length-1]<max) axis.push(max);
  const done=[], inp=[], todo=[];
  axis.forEach(D=>{
    let dn=0, ip=0, td=0;
    items.forEach(i=>{
      const cr=flowParseISO(i.created), s=flowParseISO(i.started), c=flowParseISO(i.completed);
      if(c && +c<=D){ dn++; return; }
      if(s && +s<=D){ ip++; return; }
      if(cr && +cr<=D){ td++; }
    });
    done.push(dn); inp.push(ip); todo.push(td);
  });
  return {labels:axis.map(t=>flowFmtDate(new Date(t))), done, inp, todo};
}
// Little's Law expected WIP = throughput-per-day × median cycle time.
function flowLittlesLaw(){
  const cycles=flowDurations().filter(d=>d.cycle!=null).map(d=>d.cycle).sort((a,b)=>a-b);
  const done=flowItems().filter(i=>i.completed);
  if(!done.length || !cycles.length) return null;
  const dates=done.map(i=>+flowParseISO(i.completed)).filter(Boolean).sort((a,b)=>a-b);
  const spanDays=Math.max(1,(dates[dates.length-1]-dates[0])/86400000);
  return Math.round((done.length/spanDays)*flowPct(cycles,50)*10)/10;
}
function flowAgeZones(){
  const cycles=flowDurations().filter(d=>d.cycle!=null).map(d=>d.cycle).sort((a,b)=>a-b);
  return {p50:cycles.length?flowPct(cycles,50):0, p85:cycles.length?flowPct(cycles,85):0};
}
function flowZoneColor(age, z){ return age>z.p85?'var(--red)':(age>z.p50?'var(--amber)':'var(--green)'); }
function flowZoneName(age, z){ return age>z.p85?'At risk':(age>z.p50?'Warning':'Healthy'); }
// Currently open (started, not done) items ranked by age.
function flowOpenItems(){
  const now=flowNow(), st=flowSettings();
  return flowItems().filter(i=>{ const s=flowParseISO(i.started), c=flowParseISO(i.completed); return s && !c; })
    .map(i=>{ let age=flowDayDiff(flowParseISO(i.started), now, st.periodCalc); if(age==null||age<0) age=0;
      return {id:i.id, type:flowNormType(i.type), status:i.status, age}; })
    .sort((a,b)=>b.age-a.age);
}
// Never-started (To Do) items ranked by age.
function flowBacklogItems(){
  const now=flowNow(), st=flowSettings();
  return flowItems().filter(i=>{ const s=flowParseISO(i.started), c=flowParseISO(i.completed); return !s && !c; })
    .map(i=>{ const cr=flowParseISO(i.created); let age=cr?flowDayDiff(cr, now, st.periodCalc):0; if(age==null||age<0) age=0;
      return {id:i.id, type:flowNormType(i.type), age}; })
    .sort((a,b)=>b.age-a.age);
}
// Horizontal bar list. rows: [{id, age, color}]
function flowHBars(rows){
  if(!rows.length) return '<div class="fa-sec-hint">Nothing here right now.</div>';
  const max=Math.max.apply(null, rows.map(r=>r.age))||1;
  return '<div class="fa-hbars">'+rows.map(r=>
    '<div class="fa-hbar-row"><span class="fa-hbar-lbl" title="'+esc(r.id)+'">'+esc(r.id||'-')+'</span>'+
    '<div class="fa-hbar-track"><div class="fa-hbar-fill" style="width:'+Math.max(3,Math.round(r.age/max*100))+'%;background:'+r.color+'"></div></div>'+
    '<span class="fa-hbar-val">'+r.age+'</span></div>').join('')+'</div>';
}
function flowSetBacklogThr(v){ flowBacklogThr=Math.max(1,+v||30); flowRenderGroupWork(); }
function flowToggleCfdWip(){ flowCfdShowWip=!flowCfdShowWip; flowRenderGroupFlow(); }

// ════════════════════════════════════════════════════════════════
// BOTTLENECK + SLE ATTAINMENT + DISTRIBUTION SHAPE  -  Checkpoint V3-4
// ════════════════════════════════════════════════════════════════
// Compare recent growth of queued vs in-progress bands to locate the constraint.
function flowBottleneck(cfd){
  if(!cfd) return null;
  const n=cfd.todo.length; if(n<2) return null;
  const k=Math.min(n-1, Math.max(1, Math.round(n/3)));
  const qDelta=cfd.todo[n-1]-cfd.todo[n-1-k];
  const wDelta=cfd.inp[n-1]-cfd.inp[n-1-k];
  let location;
  if(qDelta>wDelta && qDelta>0) location='Intake - the queue of unstarted work is growing fastest';
  else if(wDelta>qDelta && wDelta>0) location='Delivery - work is piling up in progress';
  else location='Balanced - neither queue is widening notably';
  return {location, qDelta, wDelta};
}
// Gaussian kernel density estimate of a value set.
function flowKde(values, samples){
  const n=values.length; if(n<2) return null;
  const mean=values.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(values.reduce((a,b)=>a+(b-mean)*(b-mean),0)/n)||1;
  const h=(1.06*sd*Math.pow(n,-0.2))||1;
  const min=Math.min.apply(null,values), max=Math.max.apply(null,values);
  const S=samples||48, xs=[], ys=[];
  for(let i=0;i<S;i++){
    const x=min+((max-min)||1)*i/(S-1);
    let d=0; for(let j=0;j<n;j++){ const u=(x-values[j])/h; d+=Math.exp(-0.5*u*u); }
    xs.push(x); ys.push(d/(n*h*Math.sqrt(2*Math.PI)));
  }
  return {xs, ys, h, min, max};
}
// Local maxima that are true modes: above 15% of the tallest peak, AND
// separated from the previous kept peak by a real valley (trough below 70%
// of the shorter of the two). Otherwise merge into the taller one. This keeps
// the detector from calling gently-rippled, tightly-clustered data "bimodal".
function flowPeaks(kde){
  if(!kde) return [];
  const ys=kde.ys, xs=kde.xs, mx=Math.max.apply(null,ys), thr=mx*0.15, raw=[];
  for(let i=1;i<ys.length-1;i++){ if(ys[i]>ys[i-1] && ys[i]>=ys[i+1] && ys[i]>=thr) raw.push(i); }
  const kept=[];
  raw.forEach(idx=>{
    if(!kept.length){ kept.push(idx); return; }
    const prev=kept[kept.length-1];
    let trough=Infinity; for(let j=prev;j<=idx;j++) trough=Math.min(trough, ys[j]);
    const shorter=Math.min(ys[prev], ys[idx]);
    if(trough < 0.70*shorter) kept.push(idx);              // genuine separate mode
    else if(ys[idx]>ys[prev]) kept[kept.length-1]=idx;     // merge: keep the taller
  });
  return kept.map(i=>({x:xs[i], y:ys[i]}));
}
function flowKdeSVG(values, color){
  const kde=flowKde(values); if(!kde) return '<div class="fa-sec-hint">Not enough data for a density curve.</div>';
  const peaks=flowPeaks(kde);
  const W=720,H=220,ml=44,mr=14,mt=16,mb=32,pw=W-ml-mr,ph=H-mt-mb;
  const maxY=Math.max.apply(null,kde.ys)||1, span=(kde.max-kde.min)||1;
  const X=x=>ml+((x-kde.min)/span)*pw, Y=y=>mt+ph-(y/maxY)*ph;
  let line='M'+X(kde.xs[0]).toFixed(1)+','+Y(kde.ys[0]).toFixed(1);
  for(let i=1;i<kde.xs.length;i++) line+=' L'+X(kde.xs[i]).toFixed(1)+','+Y(kde.ys[i]).toFixed(1);
  const area=line+' L'+X(kde.max).toFixed(1)+','+(mt+ph).toFixed(1)+' L'+X(kde.min).toFixed(1)+','+(mt+ph).toFixed(1)+' Z';
  let svg='<path d="'+area+'" fill="'+color+'" opacity="0.16"/><path d="'+line+'" fill="none" stroke="'+color+'" stroke-width="2"/>'+
    '<line x1="'+ml+'" y1="'+(mt+ph)+'" x2="'+(ml+pw)+'" y2="'+(mt+ph)+'" stroke="var(--border)"/>';
  peaks.forEach(pk=>{ svg+='<line x1="'+X(pk.x).toFixed(1)+'" y1="'+mt+'" x2="'+X(pk.x).toFixed(1)+'" y2="'+(mt+ph)+'" stroke="var(--red)" stroke-width="1" stroke-dasharray="3 3"/>'+
    '<text x="'+X(pk.x).toFixed(1)+'" y="'+(mt+10)+'" fill="var(--red)" font-size="9" text-anchor="middle">peak '+Math.round(pk.x)+'</text>'; });
  svg+='<text x="'+ml+'" y="'+(H-10)+'" fill="var(--hint)" font-size="9">'+Math.round(kde.min)+'</text>'+
       '<text x="'+(ml+pw)+'" y="'+(H-10)+'" fill="var(--hint)" font-size="9" text-anchor="end">'+Math.round(kde.max)+'</text>';
  return '<div class="fa-chart"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+svg+'</svg></div>';
}

// ════════════════════════════════════════════════════════════════
// FLOW HEALTH SCORE + RECOMMENDATIONS ENGINE  -  Checkpoint V3-5
// ════════════════════════════════════════════════════════════════
function flowLerp(x,x0,y0,x1,y1){ return x1===x0 ? y0 : y0+(x-x0)/(x1-x0)*(y1-y0); }
function flowClampN(v,a,b){ return Math.max(a,Math.min(b,v)); }
// Map a metric value to a 0-100 score by interpolating across its benchmark tiers
// (excellent≈100→75, good 75→45, attention 45→15, critical 15→0).
function flowScore(key, value){
  const b=flowBench()[key]; if(!b||value==null||isNaN(value)) return null;
  const t0=b.t[0],t1=b.t[1],t2=b.t[2]; let s;
  if(b.dir==='lower'){
    if(value<=t0) s=flowLerp(value,0,100,t0,75);
    else if(value<=t1) s=flowLerp(value,t0,75,t1,45);
    else if(value<=t2) s=flowLerp(value,t1,45,t2,15);
    else s=flowLerp(value,t2,15,t2*2,0);
  } else {
    if(value>=t0) s=flowLerp(value,t0,75,t0*1.5,100);
    else if(value>=t1) s=flowLerp(value,t1,45,t0,75);
    else if(value>=t2) s=flowLerp(value,t2,15,t1,45);
    else s=flowLerp(value,0,0,t2,15);
  }
  return Math.round(flowClampN(s,0,100));
}
function flowHealthTier(score){
  return score>=85?{c:'var(--green)',l:'Excellent'}:score>=65?{c:'var(--sky)',l:'Good'}:score>=40?{c:'var(--amber)',l:'Needs attention'}:{c:'var(--red)',l:'Critical'};
}
function flowHealthScores(){
  const durs=flowDurations();
  const leads=durs.map(d=>d.lead).filter(v=>v!=null).sort((a,b)=>a-b);
  if(leads.length<2) return null;
  const tp=flowThroughputPeriods().map(p=>p.completed);
  const ltCov=flowStats(leads).cov*100;
  const tpCov=tp.length?flowStats(tp).cov*100:null;
  const predRatio=flowPct(leads,50)?flowPct(leads,85)/flowPct(leads,50):null;
  const medLead=flowPct(leads,50), dn=flowDaysNoun();
  const subs=[
    {name:'Lead-time variability', score:flowScore('ltCov',ltCov), fmt:Math.round(ltCov)+'% CoV'},
    {name:'Throughput stability',  score:tpCov!=null?flowScore('tpCov',tpCov):null, fmt:tpCov!=null?Math.round(tpCov)+'% CoV':'-'},
    {name:'Predictability',        score:predRatio!=null?flowScore('predRatio',predRatio):null, fmt:predRatio!=null?(Math.round(predRatio*10)/10)+'x':'-'},
    {name:'Lead time',             score:flowScore('medianLead',medLead), fmt:Math.round(medLead)+' '+dn}
  ];
  const valid=subs.filter(s=>s.score!=null);
  return {overall:Math.round(valid.reduce((a,s)=>a+s.score,0)/valid.length), subs};
}
function flowRenderHealth(){
  const host=q('#fa-health'); if(!host) return;
  const h=flowHealthScores();
  if(!h){ host.innerHTML='<div class="fa-sec-hint">Import completed items to compute a health score.</div>'; return; }
  const t=flowHealthTier(h.overall);
  const bars=h.subs.map(s=>{
    const st=s.score!=null?flowHealthTier(s.score):{c:'var(--hint)'};
    return '<div class="fa-subscore"><span class="fa-subscore-nm">'+esc(s.name)+'</span>'+
      '<div class="fa-subscore-track"><div class="fa-subscore-fill" style="width:'+(s.score||0)+'%;background:'+st.c+'"></div></div>'+
      '<span class="fa-subscore-val">'+esc(s.fmt)+' ['+(s.score!=null?s.score:'-')+']</span></div>';
  }).join('');
  const valid=h.subs.filter(s=>s.score!=null).slice().sort((a,b)=>a.score-b.score);
  const focus=valid[0];
  host.innerHTML='<div class="fa-health">'+
    '<div class="fa-health-badge"><div class="fa-health-score" style="border-color:'+t.c+';color:'+t.c+'"><span class="fa-health-num">'+h.overall+'</span></div>'+
    '<span class="fa-health-lbl" style="color:'+t.c+'">'+esc(t.l)+'</span></div>'+
    '<div class="fa-subscores">'+bars+'</div></div>'+
    (focus?'<div class="fa-focus">🎯 <strong>Focus area:</strong> '+esc(focus.name)+' is your weakest dimension (score '+focus.score+'). The recommendations below target it first.</div>':'');
}

// Cross-metric recommendations. Each carries a guardrail counter-metric so no
// single fix is pursued at another metric's expense. Deduped by category, capped
// at 5, always keeping a positive signal when one exists.
function flowRecommendations(){
  const durs=flowDurations();
  const leads=durs.map(d=>d.lead).filter(v=>v!=null).sort((a,b)=>a-b);
  if(leads.length<2) return [];
  const dn=flowDaysNoun();
  const P=flowThroughputPeriods(), tp=P.map(p=>p.completed);
  const ltCov=flowStats(leads).cov*100, tpCov=tp.length?flowStats(tp).cov*100:0;
  const cumNet=P.reduce((s,p)=>s+(p.completed-p.created),0);
  const z=flowAgeZones(), open=flowOpenItems();
  const atRisk=open.filter(o=>o.age>z.p85).length;
  const both=durs.filter(d=>d.lead!=null&&d.cycle!=null);
  const fe=both.length?(both.reduce((s,d)=>s+d.cycle,0)/both.reduce((s,d)=>s+d.lead,0))*100:null;
  const totBugs=P.reduce((s,p)=>s+p.bugs,0), totDone=P.reduce((s,p)=>s+p.completed,0);
  const defPct=totDone?totBugs/totDone*100:0;
  const ll=flowLittlesLaw(), cfd=flowCfdData(), curWip=cfd?cfd.inp[cfd.inp.length-1]:0;
  const bl=flowBacklogItems(), stale=bl.filter(b=>b.age>flowBacklogThr*2).length;
  const predRatio=flowPct(leads,50)?flowPct(leads,85)/flowPct(leads,50):0;
  const recs=[];

  if(ltCov>75) recs.push({sev:'high',cat:'variability',title:'Lead time is highly variable',
    insight:'Lead-time CoV is '+Math.round(ltCov)+'%, so delivery time is close to unpredictable.',
    target:'Bring CoV under 50%.',
    steps:['Limit work in progress so items finish before new ones start','Split large items to shrink the long tail','Investigate the slowest 15% for common blockers'],
    guard:'Watch throughput as you cut WIP - it should hold or rise, not fall.', group:'pred'});
  if(cumNet<0) recs.push({sev:'high',cat:'demand',title:'Demand is outpacing delivery',
    insight:'Net flow is '+cumNet+' over the window - the backlog is growing faster than you finish.',
    target:'Get net flow to zero or positive.',
    steps:['Cap intake until the backlog stabilises','Finish in-progress work before pulling new items','Groom and close stale requests'],
    guard:'Do not just reject work - prioritise so the important items still flow.', group:'flow'});
  if(open.length && atRisk/open.length>0.2) recs.push({sev:'high',cat:'aging',title:'Aged work in progress is piling up',
    insight:atRisk+' of '+open.length+' in-progress items are past your P85 age.',
    target:'Zero items in the red zone.',
    steps:['Swarm the oldest items to done before starting anything new','Set an explicit WIP limit','Make item age visible in standup'],
    guard:'Resist starting fresh work to boost throughput - that deepens the aging.', group:'work'});

  if(fe!=null && fe<15) recs.push({sev:'medium',cat:'efficiency',title:'Most time is spent waiting, not working',
    insight:'Flow efficiency is '+Math.round(fe)+'% - items sit idle far longer than they are worked.',
    target:'Lift flow efficiency above 25%.',
    steps:['Map hand-offs and remove the longest queues','Track blocked time and escalate blockers daily','Reduce context-switching'],
    guard:'Do not compress by skipping review or testing - protect quality.', group:'pred'});
  if(tpCov>=35) recs.push({sev:tpCov>60?'high':'medium',cat:'tpstability',title:'Throughput is unstable',
    insight:'Throughput CoV is '+Math.round(tpCov)+'% - output swings a lot period to period, which weakens forecasts.',
    target:'Bring throughput CoV under 35%.',
    steps:['Keep WIP steady so completions land evenly','Break work into similar-sized items','Avoid batching "done" at the end of a period'],
    guard:'Do not chase steadiness by holding finished work back - that hides variability rather than fixing it.', group:'fore'});
  if(ll!=null && curWip>ll*1.5) recs.push({sev:'medium',cat:'wip',title:'Work in progress is above the healthy level',
    insight:'Current WIP is '+curWip+' versus a Little’s Law estimate of about '+ll+'.',
    target:'Bring WIP near '+ll+'.',
    steps:['Stop starting, start finishing','Introduce column WIP limits','Pull only when capacity frees up'],
    guard:'Keep an eye on throughput stability as WIP comes down.', group:'work'});
  if(defPct>20) recs.push({sev:'medium',cat:'quality',title:'Defects are a large share of delivery',
    insight:'Defects are '+Math.round(defPct)+'% of completed work.',
    target:'Reduce defect share below 10%.',
    steps:['Strengthen the definition of done','Add tests at the point of failure','Review why defects escape'],
    guard:'Do not stall feature delivery entirely - balance quality investment with flow.', group:'work'});
  if(predRatio>3) recs.push({sev:'medium',cat:'tail',title:'A long tail is hurting predictability',
    insight:'Your P85/P50 ratio is '+(Math.round(predRatio*10)/10)+'x - slow items are far slower than typical.',
    target:'Get the ratio under 2x.',
    steps:['Separate classes of service (expedite vs standard)','Cap item size','Address recurring blockers on the outliers'],
    guard:'Do not game the median by deferring hard items - track the tail explicitly.', group:'pred'});
  if(stale>0) recs.push({sev:'medium',cat:'backlog',title:'Stale backlog items need grooming',
    insight:stale+' backlog item'+(stale===1?'':'s')+' are past twice your stale threshold.',
    target:'Close or re-scope stale tickets.',
    steps:['Review items older than '+(flowBacklogThr*2)+' '+dn,'Close what is no longer relevant','Re-estimate what remains'],
    guard:'Capture any real need before closing - archiving is not deleting the requirement.', group:'work'});

  if(tpCov>0 && tpCov<20) recs.push({sev:'positive',cat:'stability',title:'Throughput is stable',
    insight:'Throughput CoV is '+Math.round(tpCov)+'% - steady enough for confident forecasting.',
    target:'Keep it up.', steps:['Hold the current WIP discipline'], guard:'', group:'fore'});
  if(ltCov<30) recs.push({sev:'positive',cat:'predictable',title:'Delivery is predictable',
    insight:'Lead-time CoV is '+Math.round(ltCov)+'% - comfortably in the excellent range.',
    target:'Maintain it.', steps:['Hold the line on WIP and item sizing'], guard:'', group:'pred'});

  const order={high:0,medium:1,positive:2}, seen={}, dedup=[];
  recs.sort((a,b)=>order[a.sev]-order[b.sev]);
  recs.forEach(r=>{ if(!seen[r.cat]){ seen[r.cat]=1; dedup.push(r); } });
  let capped=dedup.slice(0,5);
  if(!capped.some(r=>r.sev==='positive')){ const pos=dedup.find(r=>r.sev==='positive'); if(pos){ capped=capped.slice(0,4); capped.push(pos); } }
  return capped;
}
function flowRenderRecs(){
  const host=q('#fa-recs'); if(!host) return;
  const recs=flowRecommendations();
  if(!recs.length){ host.innerHTML='<div class="fa-sec-hint">Import completed items to generate recommendations.</div>'; return; }
  const counts={high:0,medium:0,positive:0}; recs.forEach(r=>counts[r.sev]++);
  const groupName={flow:'Flow',pred:'Predictability',work:'Work management',fore:'Forecasting'};
  let head='<div style="margin-bottom:12px;font-size:13px;color:var(--text-2)">'+recs.length+' recommendation'+(recs.length===1?'':'s')+' &nbsp;'+
    (counts.high?'<span class="fa-rec-sev high">'+counts.high+' high</span> ':'')+
    (counts.medium?'<span class="fa-rec-sev medium">'+counts.medium+' medium</span> ':'')+
    (counts.positive?'<span class="fa-rec-sev positive">'+counts.positive+' positive</span>':'')+'</div>';
  const cards=recs.map(r=>'<div class="fa-rec '+r.sev+'">'+
    '<div class="fa-rec-hd"><span class="fa-rec-sev '+r.sev+'">'+r.sev+'</span><span class="fa-rec-title">'+esc(r.title)+'</span></div>'+
    '<div class="fa-rec-insight">'+esc(r.insight)+'</div>'+
    (r.target?'<div class="fa-rec-target">🎯 <strong>Target:</strong> '+esc(r.target)+'</div>':'')+
    (r.steps&&r.steps.length?'<div class="fa-rec-target">How to get there:</div><ul class="fa-rec-steps">'+r.steps.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul>':'')+
    (r.guard?'<div class="fa-rec-guard">🛡 Guardrail: '+esc(r.guard)+'</div>':'')+
    (r.group?'<div style="margin-top:8px"><button class="fa-nav-pill" onclick="flowNavTo(\''+r.group+'\')">Go to '+esc(groupName[r.group]||r.group)+' →</button></div>':'')+
  '</div>').join('');
  host.innerHTML=head+cards;
}

// ════════════════════════════════════════════════════════════════
// SAMPLE DATA + DATA TABLE + GUIDE  -  Checkpoint V3-6 (pass A)
// ════════════════════════════════════════════════════════════════
// Generate ~100 realistic items and load them into the active team.
function flowLoadSample(){
  const types=[['Story',50],['Bug',20],['Task',15],['Epic',5],['Other',10]];
  const pick=()=>{ let r=Math.random()*100, a=0; for(const t of types){ a+=t[1]; if(r<=a) return t[0]; } return 'Story'; };
  const fib=[1,2,3,5,8], rnd=(a,b)=>a+Math.floor(Math.random()*(b-a+1));
  const start=new Date(2026,0,5), items=[]; // anchor Jan 2026
  const sprintLen=14;
  for(let i=0;i<100;i++){
    const createdOffset=rnd(0,168);                       // spread over ~24 weeks
    const created=new Date(+start+createdOffset*86400000);
    const roll=Math.random();
    const type=pick();
    const it={ id:'TEAM-'+(1001+i), type, points:fib[rnd(0,fib.length-1)],
      sprint:'Sprint '+(Math.floor(createdOffset/sprintLen)+1), created:flowToISO(created), started:'', completed:'', status:'To Do', statusCategory:'To Do' };
    if(roll<0.7){ // done
      const startGap=rnd(1,5), lead=rnd(1,type==='Bug'?18:38)+(Math.random()<0.1?rnd(10,25):0);
      const started=new Date(+created+startGap*86400000);
      const completed=new Date(+created+Math.max(startGap+1,lead)*86400000);
      it.started=flowToISO(started); it.completed=flowToISO(completed); it.status='Done'; it.statusCategory='Done';
    } else if(roll<0.85){ // in progress
      it.started=flowToISO(new Date(+created+rnd(1,5)*86400000)); it.status='In Progress'; it.statusCategory='In Progress';
    } // else stays To Do
    items.push(it);
  }
  flowSetItems(items);
  if(typeof showToast==='function') showToast('Loaded 100 sample items','g');
  if(flowSub!=='flow') flowSubTab('flow'); else renderFlow();
}

// ── Searchable, sortable data table ────────────────────────────
function flowTblSearchInput(v){ flowTblSearch=(v||'').toLowerCase(); flowRenderDataTable(); }
function flowTblSortBy(col){
  if(flowTblSort.col===col) flowTblSort.dir = flowTblSort.dir==='asc'?'desc':'asc';
  else flowTblSort={col, dir:'asc'};
  flowRenderDataTable();
}
function flowRenderDataTable(){
  const host=q('#fa-datatable'); if(!host) return;
  const durs=flowDurations();
  const byId={}; durs.forEach(d=>{ byId[d.item.id]={lead:d.lead, cycle:d.cycle}; });
  let rows=flowItems().map((i,idx)=>{
    const d=byId[i.id]||{};
    return {id:i.id||('#'+(idx+1)), type:flowNormType(i.type), status:i.status||'', created:i.created||'', started:i.started||'', completed:i.completed||'',
      points:i.points||0, lead:d.lead!=null?d.lead:null, cycle:d.cycle!=null?d.cycle:null};
  });
  if(!rows.length){ host.innerHTML='<div class="fa-sec-hint">No items imported.</div>'; return; }
  if(flowTblSearch){ const s=flowTblSearch; rows=rows.filter(r=>(r.id+' '+r.type+' '+r.status).toLowerCase().indexOf(s)>=0); }
  const col=flowTblSort.col, dir=flowTblSort.dir==='asc'?1:-1;
  rows.sort((a,b)=>{ let x=a[col], y=b[col];
    if(x==null) return 1; if(y==null) return -1;
    if(typeof x==='number' && typeof y==='number') return (x-y)*dir;
    return String(x).localeCompare(String(y))*dir; });
  const dn=flowDaysNoun();
  const cols=[['id','Item'],['type','Type'],['status','Status'],['created','Created'],['started','Started'],['completed','Completed'],['points','Pts'],['lead','Lead'],['cycle','Cycle']];
  const head=cols.map(c=>{ const arw=flowTblSort.col===c[0]?(flowTblSort.dir==='asc'?' ▲':' ▼'):''; return '<th onclick="flowTblSortBy(\''+c[0]+'\')" style="cursor:pointer">'+esc(c[1])+arw+'</th>'; }).join('');
  const body=rows.slice(0,300).map(r=>'<tr>'+
    '<td>'+esc(r.id)+'</td><td><span class="fa-pill '+flowTypeClass(r.type)+'">'+esc(r.type)+'</span></td>'+
    '<td>'+esc(r.status)+'</td><td>'+esc(r.created)+'</td><td>'+esc(r.started||'-')+'</td><td>'+esc(r.completed||'-')+'</td>'+
    '<td class="num">'+(r.points||'')+'</td><td class="num">'+(r.lead!=null?r.lead:'-')+'</td><td class="num">'+(r.cycle!=null?r.cycle:'-')+'</td></tr>').join('');
  host.innerHTML='<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">'+
    '<input type="text" placeholder="Search id, type, status…" value="'+esc(flowTblSearch)+'" oninput="flowTblSearchInput(this.value)" style="max-width:260px">'+
    '<span class="fa-sec-hint" style="margin:0">'+rows.length+' of '+flowItems().length+' items · lead/cycle in '+dn+'</span></div>'+
    '<div class="fa-prev-wrap"><div class="fa-prev-scroll"><table class="fa-prev"><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table></div>'+
    (rows.length>300?'<div class="fa-prev-foot">Showing first 300 rows</div>':'')+'</div>';
}

// ── Guide content (static) ─────────────────────────────────────
function flowRenderGuide(){
  const host=q('#fa-guide-body'); if(!host) return;
  const chartList=[
    ['Throughput trend','How much you complete each period, and how steady it is.'],
    ['Net flow','Whether the backlog is shrinking or growing.'],
    ['Cumulative flow (CFD)','Created / in-progress / done bands; the gap is your WIP.'],
    ['Flow bottleneck','Where open work piles up - intake vs delivery.'],
    ['Flow efficiency','Share of time actively worked vs waiting.'],
    ['Work type distribution','The mix of Story / Bug / Task over time.'],
    ['Lead & cycle time','How long work takes, created-to-done and started-to-done.'],
    ['Histograms','The distribution shape behind the averages.'],
    ['Distribution shape','Detects bimodal delivery (two kinds of work mixed).'],
    ['Scatterplots','Every item plotted, with P50/P85/P95 and drag-to-zoom.'],
    ['SLE + attainment','Your delivery promise and whether it holds over time.'],
    ['CoV trend','Predictability over time.'],
    ['WIP trend & aging','Open items over time and which are aging into the red.'],
    ['Backlog aging','Never-started items ranked by staleness.'],
    ['Defect trend','Bugs as a share of throughput.'],
    ['Monte Carlo','Forecast how many, or when, from 10,000 simulations.']
  ];
  host.innerHTML=
    '<div class="fa-sec-hint">All processing happens in your browser. Nothing is uploaded; your Jira token is never stored.</div>'+
    '<div class="fa-map-hd" style="margin:14px 0 6px">Quick start</div>'+
    '<ol class="fa-rec-steps" style="margin-left:18px">'+
      '<li>Export your issues from Jira as CSV (include Created and a completed date such as Status Category Changed).</li>'+
      '<li>Open <strong>Flow Metrics</strong>, drop the CSV in, and map the columns.</li>'+
      '<li>Explore the four groups, or read the health score and recommendations up top.</li>'+
    '</ol>'+
    '<div style="margin:10px 0"><button class="btn btn-primary btn-sm" onclick="flowLoadSample()">Try with 100 sample items</button></div>'+
    '<div class="fa-map-hd" style="margin:16px 0 6px">What is Flow Metrics?</div>'+
    '<div class="fa-ctx-txt">Flow metrics measure how work moves through your team: how fast (lead and cycle time), how much (throughput), how predictably (variability, SLE), and where it gets stuck (WIP, aging, bottlenecks). They complement story-point velocity with delivery-focused, item-level signals.</div>'+
    '<div class="fa-map-hd" style="margin:16px 0 6px">Charts explained</div>'+
    '<div class="fa-prev-wrap"><div class="fa-prev-scroll"><table class="fa-prev"><thead><tr><th>Chart</th><th>What it tells you</th></tr></thead><tbody>'+
      chartList.map(c=>'<tr><td>'+esc(c[0])+'</td><td>'+esc(c[1])+'</td></tr>').join('')+'</tbody></table></div></div>'+
    '<div class="fa-map-hd" style="margin:16px 0 6px">Benchmarks are reference ranges</div>'+
    '<div class="fa-ctx-txt">The Excellent / Good / Needs attention / Critical thresholds follow common industry references, but healthy ranges differ by team and work type. Tune them under Flow Metrics → settings → Benchmark thresholds.</div>'+
    '<div class="fa-map-hd" style="margin:16px 0 6px">Further reading</div>'+
    '<div class="fa-ctx-txt">Daniel Vacanti, <em>Actionable Agile Metrics for Predictability</em> and <em>When Will It Be Done?</em> · David Anderson, <em>Kanban</em> · Forsgren, Humble, Kim, <em>Accelerate</em>.</div>';
}

// ════════════════════════════════════════════════════════════════
// ZIP EXPORT (store-only, no JSZip) + ANNOTATIONS  -  Checkpoint V3-6 (pass B)
// ════════════════════════════════════════════════════════════════
function flowCrc32(bytes){
  let crc=0xFFFFFFFF;
  for(let i=0;i<bytes.length;i++){
    let c=(crc^bytes[i])&0xFF;
    for(let k=0;k<8;k++) c = (c&1) ? (c>>>1)^0xEDB88320 : c>>>1;
    crc=(crc>>>8)^c;
  }
  return (crc^0xFFFFFFFF)>>>0;
}
// Build a valid .zip Blob from [{name, bytes:Uint8Array}] using the store method.
function flowMakeZip(files){
  const enc=new TextEncoder(), chunks=[], central=[]; let offset=0;
  files.forEach(f=>{
    const nb=enc.encode(f.name), crc=flowCrc32(f.bytes), sz=f.bytes.length;
    const lh=new Uint8Array(30+nb.length), dv=new DataView(lh.buffer);
    dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint16(6,0,true);
    dv.setUint16(8,0,true); dv.setUint16(10,0,true); dv.setUint16(12,0,true);
    dv.setUint32(14,crc,true); dv.setUint32(18,sz,true); dv.setUint32(22,sz,true);
    dv.setUint16(26,nb.length,true); dv.setUint16(28,0,true); lh.set(nb,30);
    chunks.push(lh, f.bytes);
    const ch=new Uint8Array(46+nb.length), cv=new DataView(ch.buffer);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true);
    cv.setUint16(8,0,true); cv.setUint16(10,0,true); cv.setUint16(12,0,true); cv.setUint16(14,0,true);
    cv.setUint32(16,crc,true); cv.setUint32(20,sz,true); cv.setUint32(24,sz,true);
    cv.setUint16(28,nb.length,true); cv.setUint32(42,offset,true); ch.set(nb,46);
    central.push(ch); offset+=lh.length+sz;
  });
  const cSize=central.reduce((s,c)=>s+c.length,0), cOff=offset;
  central.forEach(c=>chunks.push(c));
  const eo=new Uint8Array(22), ev=new DataView(eo.buffer);
  ev.setUint32(0,0x06054b50,true); ev.setUint16(8,files.length,true); ev.setUint16(10,files.length,true);
  ev.setUint32(12,cSize,true); ev.setUint32(16,cOff,true);
  chunks.push(eo);
  return new Blob(chunks,{type:'application/zip'});
}
function flowExportCharts(){
  const svgs=document.querySelectorAll('#sub-flow svg');
  if(!svgs.length){ if(typeof showToast==='function') showToast('No charts to export yet','a'); return; }
  const enc=new TextEncoder(), files=[], used={};
  svgs.forEach((svg,i)=>{
    const row=svg.closest('.fa-row'), card=svg.closest('.sc');
    let name=(row&&row.querySelector('.fa-row-title')&&row.querySelector('.fa-row-title').textContent)
      || (card&&card.querySelector('.sc-title')&&card.querySelector('.sc-title').textContent) || ('chart-'+(i+1));
    name=name.trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'chart';
    used[name]=(used[name]||0)+1; if(used[name]>1) name+='-'+used[name];
    let s=new XMLSerializer().serializeToString(svg);
    if(s.indexOf('xmlns')<0) s=s.replace('<svg','<svg xmlns="http://www.w3.org/2000/svg"');
    files.push({name:(i+1<10?'0':'')+(i+1)+'-'+name+'.svg', bytes:enc.encode(s)});
  });
  const blob=flowMakeZip(files);
  const d=new Date(), pad=n=>(n<10?'0':'')+n;
  const ts=d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes());
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download='flow-metrics-charts-'+ts+'.zip'; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
  if(typeof showToast==='function') showToast(files.length+' charts exported','g');
}

// ── Single-chart export (SVG download) ─────────────────────────
function flowExportBtn(title){
  return '<button class="fa-export-btn" title="Export this chart as SVG" onclick="flowExportOne(this,\''+String(title||'chart').replace(/[^A-Za-z0-9 ]/g,'')+'\')">⬇ SVG</button>';
}
function flowExportOne(btn, title){
  const cont=btn.closest('.fa-chart')||btn.closest('.fa-row')||btn.closest('.sc-body');
  const svg=cont&&cont.querySelector('svg');
  if(!svg){ if(typeof showToast==='function') showToast('No chart to export here','a'); return; }
  let s=new XMLSerializer().serializeToString(svg);
  if(s.indexOf('xmlns')<0) s=s.replace('<svg','<svg xmlns="http://www.w3.org/2000/svg"');
  const name=(String(title||'chart').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40))||'chart';
  const url=URL.createObjectURL(new Blob([s],{type:'image/svg+xml'})), a=document.createElement('a');
  a.href=url; a.download=name+'.svg'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  if(typeof showToast==='function') showToast('Exported '+name+'.svg','g');
}

// ── ANNOTATIONS (event markers on date-axis charts) ────────────
function flowAnnotations(){ const t=at(); return (t&&flowStore.teams[t.id]&&flowStore.teams[t.id].annotations)||[]; }
function flowAddAnnotation(){
  const t=at(); if(!t) return;
  const dEl=q('#fa-annot-date'), lEl=q('#fa-annot-label');
  const date=dEl&&dEl.value, label=(lEl&&lEl.value||'').trim();
  if(!date||!label){ if(typeof showToast==='function') showToast('Enter a date and a label','a'); return; }
  if(!flowStore.teams[t.id]) flowStore.teams[t.id]={};
  const arr=flowStore.teams[t.id].annotations||(flowStore.teams[t.id].annotations=[]);
  arr.push({date,label}); arr.sort((a,b)=>a.date.localeCompare(b.date));
  flowPersist(); if(dEl)dEl.value=''; if(lEl)lEl.value='';
  flowRenderAnnotEditor(); flowRenderGroupPred();
}
function flowDelAnnotation(i){ const arr=flowAnnotations(); arr.splice(i,1); flowPersist(); flowRenderAnnotEditor(); flowRenderGroupPred(); }
function flowRenderAnnotEditor(){
  const host=q('#fa-annot-edit'); if(!host) return;
  const arr=flowAnnotations();
  const list=arr.length ? arr.map((a,i)=>'<div class="fa-hbar-row"><span class="fa-hbar-lbl" style="width:auto">'+esc(a.date)+'</span>'+
      '<span style="flex:1">'+esc(a.label)+'</span><button class="ico-btn" onclick="flowDelAnnotation('+i+')" title="Remove">×</button></div>').join('')
    : '<div class="fa-sec-hint">No annotations yet. Mark team changes, incidents, or holidays to give trends context.</div>';
  host.innerHTML='<div class="fa-mc-controls" style="margin-bottom:10px">'+
    '<div class="fi"><label class="fl">Date</label><input type="date" id="fa-annot-date"></div>'+
    '<div class="fi" style="flex:2"><label class="fl">Label</label><input type="text" id="fa-annot-label" placeholder="e.g. Two engineers joined"></div>'+
    '<div class="fi" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" onclick="flowAddAnnotation()">Add</button></div></div>'+list;
}

// ════════════════════════════════════════════════════════════════
// SPRINT COMPARISON (Sprint Insights) — compare any two sprints from
// the issues already imported in Flow Metrics (grouped by item.sprint).
// ════════════════════════════════════════════════════════════════
let flowCmpA=null, flowCmpB=null, flowCmpFieldsOpen=false;   // remember the "Choose metrics" accordion state across re-renders
// Sprints Jira reported as state=active at import time (still in progress). Set by the
// velocity import so the comparison can flag partial, snapshot-in-time data.
function flowActiveSprints(){ const t=at(); return (t && flowStore.teams[t.id] && flowStore.teams[t.id].activeSprints) || []; }
function flowSetActiveSprints(names){ const t=at(); if(!t) return; if(!flowStore.teams[t.id]) flowStore.teams[t.id]={}; flowStore.teams[t.id].activeSprints = names||[]; flowPersist(); }
function flowSprintInProgress(name){ return flowActiveSprints().indexOf(name)>=0; }
function flowSprintLabel(name){ return esc(name)+(flowSprintInProgress(name)?' (in progress)':''); }
function flowSprintList(){
  const items=flowAllItems(), recent={};
  items.forEach(i=>{ const s=i.sprint; if(!s) return; const d=i.completed||i.created||''; if(!recent[s]||d>recent[s]) recent[s]=d; });
  return Object.keys(recent).sort((a,b)=> recent[a]<recent[b]?1 : recent[a]>recent[b]?-1 : (a<b?1:-1)); // most recent first
}
function flowSprintStats(sprint){
  const items=flowAllItems().filter(i=>i.sprint===sprint);
  const durs=flowAllDurations().filter(d=>d.item.sprint===sprint);
  return flowStatsFor(items, durs, sprint);
}
// Compute the flow criteria for an arbitrary set of items+durations (used per sprint AND for the overall row).
function flowStatsFor(items, durs, label){
  const sprint=label;
  const completed=items.filter(i=>i.completed);
  const leads=durs.filter(d=>d.lead!=null).map(d=>d.lead).sort((a,b)=>a-b);
  const cycles=durs.filter(d=>d.cycle!=null).map(d=>d.cycle).sort((a,b)=>a-b);
  const both=durs.filter(d=>d.lead!=null&&d.cycle!=null);
  const waits=both.map(d=>d.lead-d.cycle).filter(v=>v>=0).sort((a,b)=>a-b);       // created -> started
  const pointedDone=completed.filter(i=>+i.points>0);
  const bugsDone=completed.filter(i=>flowNormType(i.type)==='Bug').length;
  const hasA=completed.some(i=>i.assignee);
  const byA={}; completed.forEach(i=>{ const a=i.assignee||'Unassigned'; byA[a]=(byA[a]||0)+1; });
  const types={}; items.forEach(i=>{ const t=flowNormType(i.type); types[t]=(types[t]||0)+1; });
  return {sprint, total:items.length, done:completed.length,
    rate: items.length?Math.round(completed.length/items.length*100):0,
    spillover: items.length-completed.length,
    donePts: Math.round(completed.reduce((s,i)=>s+(+i.points||0),0)*10)/10,
    pointed: items.filter(i=>+i.points>0).length,
    avgSize: pointedDone.length?Math.round(pointedDone.reduce((s,i)=>s+(+i.points),0)/pointedDone.length*10)/10:null,
    medLead: leads.length?flowPct(leads,50):null,
    p85Lead: leads.length?flowPct(leads,85):null,
    ltCov: leads.length>1?Math.round(flowStats(leads).cov*1000)/10:null,
    medCycle: cycles.length?flowPct(cycles,50):null,
    medWait: waits.length?flowPct(waits,50):null,
    flowEff: both.length?Math.round(both.reduce((s,d)=>s+d.cycle,0)/both.reduce((s,d)=>s+d.lead,0)*100):null,
    defectRate: completed.length?Math.round(bugsDone/completed.length*100):0,
    contributors: hasA?Object.keys(byA).length:null,
    concentration: hasA?Math.round(Math.max(0,...Object.values(byA))/completed.length*100):null,
    types};
}
function flowCmpDelta(a,b,dir,unit){
  if(a==null||b==null||!dir) return '';
  const d=Math.round((a-b)*10)/10;
  if(d===0) return '<span style="color:var(--hint)">no change</span>';
  const improving = dir==='higher'? d>0 : d<0;
  return '<span style="color:'+(improving?'var(--green)':'var(--red)')+'">'+(d>0?'▲':'▼')+' '+Math.abs(d)+(unit||'')+'</span>';
}
// Data-driven metric catalogue: dir = which direction is better, about = what it means,
// tip = how to improve when it is worse. `days:true` metrics render in working/calendar days.
const FLOW_CMP_METRICS=[
  {key:'done',         label:'Completed (done)',              dir:'higher', unit:'',   about:'Items finished in the sprint.',                         tip:'Keep stories small and well-refined and limit work-in-progress so more items reach Done.'},
  {key:'rate',         label:'Completion rate',               dir:'higher', unit:'%',  about:'Share of the sprint that finished.',                    tip:'Commit to less or split large stories, and protect the sprint from mid-sprint scope changes.'},
  {key:'spillover',    label:'Incomplete (spillover)',        dir:'lower',  unit:'',   about:'Items left unfinished at sprint end.',                  tip:'Right-size the commitment and cut WIP; break big items down before pulling them in.'},
  {key:'total',        label:'Total in sprint',               dir:null,     unit:'',   about:'Items currently in the sprint (context, not good or bad).'},
  {key:'donePts',      label:'Story points done',             dir:'higher', unit:'',   about:'Completed story points.',                               tip:'Rises as completion and refinement improve; do not chase points for their own sake.'},
  {key:'avgSize',      label:'Avg item size',                 dir:null,     unit:' pts',about:'Average points per completed pointed item (context).'},
  {key:'medLead',      label:'Median lead time',              dir:'lower',  days:true, about:'Typical time from created to done.',                    tip:'Start items sooner after they are ready and limit WIP to cut waiting before work begins.'},
  {key:'p85Lead',      label:'P85 lead time',                 dir:'lower',  days:true, about:'The slow tail: 85% of items finish within this.',      tip:'Unblock aged items and cap WIP so nothing lingers in the tail.'},
  {key:'ltCov',        label:'Lead-time variability (CoV)',   dir:'lower',  unit:'%',  about:'How predictable lead time is (lower = steadier).',      tip:'Make item sizes consistent and remove blockers to stabilise delivery time.'},
  {key:'medCycle',     label:'Median cycle time',             dir:'lower',  days:true, about:'Typical time from started to done.',                    tip:'Limit WIP and swarm on fewer items; remove hand-off delays.'},
  {key:'medWait',      label:'Time to start (median)',        dir:'lower',  days:true, about:'Typical wait from created to started.',                 tip:'Pull work sooner once it is ready; avoid starting many items at once.'},
  {key:'flowEff',      label:'Flow efficiency',               dir:'higher', unit:'%',  about:'Active time vs total time (higher = less waiting).',    tip:'Cut waiting and blocked time between active work; reduce hand-offs and dependencies.'},
  {key:'defectRate',   label:'Defect rate',                   dir:'lower',  unit:'%',  about:'Share of completed items that were bugs.',              tip:'Strengthen the Definition of Done, add tests and reviews, and sharpen acceptance criteria.'},
  {key:'contributors', label:'Contributors',                  dir:'higher', unit:'',   about:'How many people completed work (higher = less bus-factor risk).', tip:'Spread work and pair or rotate so knowledge is not siloed.'},
  {key:'concentration',label:'Load concentration (top person)',dir:'lower', unit:'%',  about:'Share done by the busiest person (lower = better spread).', tip:'Rebalance assignments so one person is not carrying most of the sprint.'}
];
function flowCmpFields(){ const s=flowSettings(); if(!Array.isArray(s.cmpFields)) s.cmpFields=FLOW_CMP_METRICS.map(m=>m.key); return s.cmpFields; }
function flowToggleCmpField(key){ const arr=flowCmpFields(); const i=arr.indexOf(key); if(i>=0)arr.splice(i,1); else arr.push(key); flowPersist(); flowRenderSprintCompare(); }
function flowSetCmp(which,val){ if(which==='A')flowCmpA=val; else flowCmpB=val; flowRenderSprintCompare(); }
function flowRenderSprintCompare(){
  const host=q('#fa-sprintcmp'); if(!host) return;
  const list=flowSprintList();
  if(list.length<2){
    host.innerHTML='<div class="fa-sec-hint">Import a Jira issue CSV that has a Sprint column (with at least two sprints) in the Flow Metrics tab, and the two-sprint comparison will appear here.</div>';
    return;
  }
  if(!flowCmpA || list.indexOf(flowCmpA)<0) flowCmpA=list[0];
  if(!flowCmpB || list.indexOf(flowCmpB)<0) flowCmpB=list[1]===flowCmpA?list[0]:list[1];
  const A=flowSprintStats(flowCmpA), B=flowSprintStats(flowCmpB), dn=flowDaysNoun();
  const selKeys=flowCmpFields();
  const chosen=FLOW_CMP_METRICS.filter(m=>selKeys.indexOf(m.key)>=0);
  const opts=sel=>list.map(s=>'<option value="'+esc(s)+'"'+(s===sel?' selected':'')+'>'+flowSprintLabel(s)+'</option>').join('');
  const num=(v,u)=>v==null?'-':(v+(u||''));
  const eff=m=>m.days?(' '+dn):(m.unit||'');
  let html='<div class="fa-cmp-controls"><label class="fl">Sprint A</label><select onchange="flowSetCmp(\'A\',this.value)">'+opts(flowCmpA)+'</select>'+
    '<span style="color:var(--hint);font-size:12px">vs</span><label class="fl">Sprint B</label><select onchange="flowSetCmp(\'B\',this.value)">'+opts(flowCmpB)+'</select></div>';
  // Pick which metrics to compare
  html+='<details class="fa-cmp-fields"'+(flowCmpFieldsOpen?' open':'')+' ontoggle="flowCmpFieldsOpen=this.open"><summary>Choose metrics ('+chosen.length+' of '+FLOW_CMP_METRICS.length+')</summary><div class="fa-cmp-fieldgrid">'+
    FLOW_CMP_METRICS.map(m=>'<label class="fa-cmp-fld"><input type="checkbox" '+(selKeys.indexOf(m.key)>=0?'checked':'')+' onchange="flowToggleCmpField(\''+m.key+'\')"> '+esc(m.label)+'</label>').join('')+'</div></details>';
  // Comparison table (only chosen metrics). "Better" flags the stronger sprint per metric.
  html+='<table class="fa-cmp-tbl"><thead><tr><th>Metric</th><th class="num">'+flowSprintLabel(flowCmpA)+'</th><th class="num">'+flowSprintLabel(flowCmpB)+'</th><th>Change (A vs B)</th><th>Better</th></tr></thead><tbody>';
  if(!chosen.length) html+='<tr><td colspan="5" style="color:var(--hint)">No metrics selected. Use "Choose metrics" above.</td></tr>';
  chosen.forEach(m=>{ const u=eff(m), a=A[m.key], b=B[m.key];
    let better='';
    if(m.dir && a!=null && b!=null){ if(a===b) better='<span style="color:var(--hint)">tie</span>'; else { const aWins=(m.dir==='higher')?a>b:a<b; better='<span class="fa-cmp-win" style="color:'+(aWins?'var(--green)':'var(--red)')+'">'+(aWins?'A':'B')+'</span>'; } }
    html+='<tr><td title="'+esc(m.about||'')+'">'+esc(m.label)+'</td><td class="num">'+num(a,u)+'</td><td class="num">'+num(b,u)+'</td><td>'+flowCmpDelta(a,b,m.dir,u)+'</td><td>'+better+'</td></tr>';
  });
  html+='</tbody></table>';
  // Read + recommendations: which is better overall, and how to improve the weak spots.
  const scored=chosen.filter(m=>m.dir && A[m.key]!=null && B[m.key]!=null && A[m.key]!==B[m.key]);
  const imp=[], reg=[];
  scored.forEach(m=>{ const aWins=(m.dir==='higher')?A[m.key]>B[m.key]:A[m.key]<B[m.key]; (aWins?imp:reg).push(m); });
  if(chosen.some(m=>m.dir)){
    html+='<div class="fa-cmp-summary"><div class="fa-map-hd" style="margin-bottom:6px">Read: '+flowSprintLabel(flowCmpA)+' vs '+flowSprintLabel(flowCmpB)+'</div>'+
      '<p style="font-size:12.5px;color:var(--text-2);margin:0 0 8px">Sprint A is better on <strong style="color:var(--green)">'+imp.length+'</strong> and worse on <strong style="color:var(--red)">'+reg.length+'</strong> of '+scored.length+' judged metric'+(scored.length===1?'':'s')+' (green/red in the Better column).</p>';
    if(imp.length) html+='<div style="font-size:12.5px;margin-bottom:6px"><strong style="color:var(--green)">✓ Stronger in A:</strong> '+imp.map(m=>esc(m.label)).join(', ')+'.</div>';
    if(reg.length) html+='<div style="font-size:12.5px"><strong style="color:var(--red)">⚠ Weaker in A, how to improve:</strong><ul class="fa-cmp-tips">'+reg.map(m=>'<li><strong>'+esc(m.label)+':</strong> '+esc(m.tip||'')+'</li>').join('')+'</ul></div>';
    else if(scored.length) html+='<div style="font-size:12.5px;color:var(--green)">No regressions in A on the selected metrics. Keep the practices that got you here.</div>';
    html+='</div>';
  }
  const present=['Story','Bug','Task','Epic','Other'].filter(k=>A.types[k]||B.types[k]);
  const mix=st=>present.map(k=>'<span class="fa-pill '+flowTypeClass(k)+'">'+k+' '+(st.types[k]||0)+'</span>').join(' ')||'-';
  html+='<div class="fa-map-hd" style="margin:14px 0 6px">Work type mix</div>'+
    '<div class="fa-cmp-mix"><div><strong>'+flowSprintLabel(flowCmpA)+':</strong> '+mix(A)+'</div><div style="margin-top:6px"><strong>'+flowSprintLabel(flowCmpB)+':</strong> '+mix(B)+'</div></div>';
  if(flowSprintInProgress(flowCmpA)||flowSprintInProgress(flowCmpB)){
    const which=[flowSprintInProgress(flowCmpA)?esc(flowCmpA):null, flowSprintInProgress(flowCmpB)?esc(flowCmpB):null].filter(Boolean).join(' and ');
    html+='<div class="fa-warn amber" style="margin-top:12px">⚠ <span>'+which+' is still in progress, so Completed, Completion rate and spillover are a snapshot as of now and will look low until the sprint closes. Lead/cycle time and flow efficiency (per completed item) are still fair to compare.</span></div>';
  }
  html+='<div class="fa-warn sky" style="margin-top:12px">ℹ <span>"Completed" is Done now and "Total" is what is currently in the sprint (this export has no start-of-sprint baseline). Story points cover '+A.pointed+' of '+A.total+' items in '+esc(flowCmpA)+' and '+B.pointed+' of '+B.total+' in '+esc(flowCmpB)+', so read points and avg item size as rough signals. P85 and CoV need several completed items; time to start and flow efficiency need a Start date mapped.</span></div>';
  host.innerHTML=html;
}

// ── Team load / bus-factor (team-health signal, NOT a ranking) ──
function flowLoadStats(sprint){
  const done=flowAllItems().filter(i=>i.sprint===sprint && i.completed);
  const by={}; done.forEach(i=>{ const a=i.assignee||'Unassigned'; by[a]=(by[a]||0)+1; });
  const entries=Object.entries(by).sort((a,b)=>b[1]-a[1]);
  return {entries, total:done.length, contributors:entries.length, topShare: done.length?Math.round(entries[0][1]/done.length*100):0};
}
function flowRenderTeamLoad(){
  const host=q('#ana-load'); if(!host) return;
  const items=flowAllItems();
  if(!items.length){ host.innerHTML='<div class="fa-sec-hint">Import Jira issues in the Flow Metrics tab to see how work is spread across the team.</div>'; return; }
  if(!items.some(i=>i.assignee)){ host.innerHTML='<div class="fa-sec-hint">Map the <strong>Assignee</strong> column in the Flow Metrics CSV importer (it is in your export) to see team load and bus-factor.</div>'; return; }
  const list=flowSprintList();
  const A=(flowCmpA&&list.indexOf(flowCmpA)>=0)?flowCmpA:list[0];
  const B=(flowCmpB&&list.indexOf(flowCmpB)>=0)?flowCmpB:list[1];
  const block=sprint=>{
    if(!sprint) return '';
    const s=flowLoadStats(sprint);
    if(!s.total) return '<div style="margin-bottom:12px"><span class="fa-map-hd">'+esc(sprint)+'</span> <span style="color:var(--hint);font-size:12px">no completed items</span></div>';
    const max=s.entries[0][1];
    const bars=s.entries.map(e=>'<div class="fa-hbar-row"><span class="fa-hbar-lbl" style="width:120px" title="'+esc(e[0])+'">'+esc(e[0])+'</span>'+
      '<div class="fa-hbar-track"><div class="fa-hbar-fill" style="width:'+Math.max(5,Math.round(e[1]/max*100))+'%;background:var(--primary)"></div></div><span class="fa-hbar-val">'+e[1]+'</span></div>').join('');
    const risk=s.topShare>=60?'amber':'green';
    return '<div style="margin-bottom:16px"><div class="fa-map-hd" style="margin-bottom:6px">'+esc(sprint)+' <span class="fa-opt">('+s.contributors+' contributor'+(s.contributors===1?'':'s')+')</span></div>'+bars+
      '<div class="fa-warn '+risk+'" style="margin-top:8px"><span>Top person completed <strong>'+s.topShare+'%</strong> of the work. '+
      (s.topShare>=60?'Concentrated: a bus-factor risk worth discussing as a team.':'Reasonably spread across the team.')+'</span></div></div>';
  };
  host.innerHTML='<div class="fa-sec-hint">How completed work was spread across people, for the two sprints selected in the comparison above. This is a team-health and bus-factor signal, not an individual performance ranking.</div>'+block(A)+block(B);
}

// ── BOOT ───────────────────────────────────────────────────────
flowLoad();
document.addEventListener('DOMContentLoaded', ()=>{ /* settings synced on page open */ });
