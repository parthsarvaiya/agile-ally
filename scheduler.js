'use strict';
/* ════════════════════════════════════════════════════════════════
   CEREMONY SCHEDULER  -  P1
   Rotates who leads each ceremony across the sprint, fairly and
   leave-aware, using a least-loaded-available algorithm.

   Relies on globals from index.html: at(), q, esc, showToast, dSave,
   holidays. Config lives on the team (team.sched); per-member leave on
   m.leave = [{from,to}] (ISO dates) - both persisted by the existing
   persist() since they hang off the teams model.
   ════════════════════════════════════════════════════════════════ */

const SCHED_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const SCHED_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
let schedView = 'ceremony';   // 'ceremony' | 'list' | 'calendar'
let schedCalIdx = null;       // calendar month shown as year*12+month; null = default to sprint start
let schedHorizon = 0;         // rota look-ahead in months past the current sprint (0 = current sprint only)
function schedDefaultCeremonies(){
  return [
    {key:'standup',    name:'Daily Standup',   cadence:'daily',      weekday:null, enabled:true},
    {key:'refinement', name:'Refinement',      cadence:'weekly',     weekday:2,    enabled:true},
    {key:'grooming',   name:'Backlog Grooming',cadence:'weekly',     weekday:4,    enabled:true},
    {key:'demo',       name:'Sprint Demo',     cadence:'sprint-end', weekday:null, enabled:true},
    {key:'retro',      name:'Retrospective',   cadence:'sprint-end', weekday:null, enabled:true}
  ];
}
function schedCfg(){
  const t=at(); if(!t) return null;
  if(!t.sched || !Array.isArray(t.sched.ceremonies)) t.sched={ceremonies:schedDefaultCeremonies()};
  // Migration: seed the Demo ceremony for teams created before it existed (idempotent, keeps user edits).
  if(!t.sched.ceremonies.some(c=>c.key==='demo')){
    const demo={key:'demo', name:'Sprint Demo', cadence:'sprint-end', weekday:null, enabled:true};
    const ri=t.sched.ceremonies.findIndex(c=>c.key==='retro');
    if(ri>=0) t.sched.ceremonies.splice(ri,0,demo); else t.sched.ceremonies.push(demo);
  }
  return t.sched;
}
function schedCerOrder(key){ const c=schedCfg(); const i=c?c.ceremonies.findIndex(x=>x.key===key):-1; return i<0?99:i; }
function schedCerClass(key){ return ['standup','refinement','grooming','demo','retro'].indexOf(key)>=0?key:'other'; }

// ── DATE HELPERS ───────────────────────────────────────────────
function schedISO(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function schedFmt(iso){ const d=new Date(iso+'T00:00:00'); return '<span class="dow">'+SCHED_DOW[d.getDay()]+'</span> '+d.getDate()+' '+SCHED_MON[d.getMonth()]; }
function schedMonday(iso){ const d=new Date(iso+'T00:00:00'); const off=(d.getDay()+6)%7; d.setDate(d.getDate()-off); return schedISO(d); }
function schedWeekLabel(iso){ const m=new Date(schedMonday(iso)+'T00:00:00'); const s=new Date(m); const e=new Date(m); e.setDate(e.getDate()+6);
  return 'Week of '+s.getDate()+' '+SCHED_MON[s.getMonth()]+' - '+e.getDate()+' '+SCHED_MON[e.getMonth()]; }
function schedWorkingDays(startISO, endISO){
  const holSet=new Set((holidays||[]).map(h=>h.date)), out=[];
  let cur=new Date(startISO+'T00:00:00'); const end=new Date(endISO+'T00:00:00');
  let guard=0;
  while(cur<=end && guard++<400){ const dow=cur.getDay(), iso=schedISO(cur);
    if(dow!==0 && dow!==6 && !holSet.has(iso)) out.push(iso);
    cur.setDate(cur.getDate()+1); }
  return out;
}

// ── FUTURE-SPRINT PROJECTION ───────────────────────────────────
// The scheduler models one sprint window (t.cfg.startDate..endDate). To look
// ahead, we project consecutive sprints of the SAME working-day length, each
// starting the next working day after the previous ends, reusing the cadence
// config. PTO/overrides only exist for the current sprint, so projected sprints
// assume everyone is available; the rotation still continues for fairness.
function schedNextWorkingDay(iso){
  const holSet=new Set((holidays||[]).map(h=>h.date)); const d=new Date(iso+'T00:00:00');
  let g=0; do{ d.setDate(d.getDate()+1); }while(g++<500 && (d.getDay()===0||d.getDay()===6||holSet.has(schedISO(d))));
  return schedISO(d);
}
function schedNthWorkingDay(startIso, n){   // 1-indexed; counts startIso itself if it is a working day
  const holSet=new Set((holidays||[]).map(h=>h.date)); const d=new Date(startIso+'T00:00:00');
  let count=0, g=0;
  while(g++<1000){ const dow=d.getDay(), iso=schedISO(d);
    if(dow!==0 && dow!==6 && !holSet.has(iso)){ count++; if(count>=n) return iso; }
    d.setDate(d.getDate()+1); }
  return schedISO(d);
}
function schedAddMonths(iso, months){ const d=new Date(iso+'T00:00:00'); d.setMonth(d.getMonth()+months); return schedISO(d); }
// Sprint windows to cover `horizonMonths` past the current sprint start (0 = current sprint only).
function schedWindows(horizonMonths){
  const t=at(); if(!t || !t.cfg || !t.cfg.startDate || !t.cfg.endDate) return [];
  const wins=[{start:t.cfg.startDate, end:t.cfg.endDate, idx:0}];
  if(!(horizonMonths>0)) return wins;
  const len=schedWorkingDays(t.cfg.startDate, t.cfg.endDate).length; if(!len) return wins;
  const limit=schedAddMonths(t.cfg.startDate, horizonMonths);
  let prev=wins[0], g=0;
  while(g++<60){
    const ns=schedNextWorkingDay(prev.end); if(ns>limit) break;
    const w={start:ns, end:schedNthWorkingDay(ns, len), idx:prev.idx+1};
    wins.push(w); prev=w;
  }
  return wins;
}

// ── OCCURRENCES ────────────────────────────────────────────────
function schedDayOffset(iso, days){ const d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+days); return schedISO(d); }
function schedWeeksBetween(mondayA, mondayB){ return Math.round((new Date(mondayB+'T00:00:00')-new Date(mondayA+'T00:00:00'))/(7*86400000)); }
// Pick the configured weekday within a week's working days, else the middle available day.
function schedPickInWeek(days, weekday){
  let pick=days.find(iso=>new Date(iso+'T00:00:00').getDay()===weekday);
  if(!pick) pick=days[Math.min(days.length-1, Math.floor(days.length/2))];
  return pick;
}
// If a date lands on a weekend/holiday, shift to the nearest working day (searches ±3 days).
function schedShiftWorkingDay(iso){
  const holSet=new Set((holidays||[]).map(h=>h.date));
  const ok=d=>{ const x=new Date(d+'T00:00:00').getDay(); return x!==0 && x!==6 && !holSet.has(d); };
  if(ok(iso)) return iso;
  for(let off=1; off<=3; off++){ const a=schedDayOffset(iso,off); if(ok(a)) return a; const b=schedDayOffset(iso,-off); if(ok(b)) return b; }
  return iso;
}
// Absolute 14-day cadence phased on `anchor`, returning working days inside [s,e].
// The cadence is independent of sprint boundaries, so spacing is always exactly a fortnight.
function schedBiweeklyFromAnchor(anchor, s, e){
  const MS=14*86400000;
  const A=new Date(anchor+'T00:00:00'), S=new Date(s+'T00:00:00'), E=new Date(e+'T00:00:00');
  let k=Math.ceil((S-A)/MS), out=[], g=0;   // first grid point on or after s (k may be negative)
  while(g++<80){
    const d=new Date(A.getTime()+k*MS); if(d>E) break;
    if(d>=S) out.push(schedShiftWorkingDay(schedISO(d)));
    k++;
  }
  return out;
}
// Ceremony occurrences within a single window's working days, tagged with the sprint index.
// `phaseMon` = the Monday the no-anchor bi-weekly cadence is phased to (the current sprint's
// first week), so every-other-week stays continuous across projected sprints.
function schedOccForWindow(cfg, win, phaseMon){
  const wds=schedWorkingDays(win.start, win.end); if(!wds.length) return [];
  const occ=[]; const mk=(c,iso)=>({date:iso, key:c.key, name:c.name, sprint:win.idx||0});
  cfg.ceremonies.filter(c=>c.enabled).forEach(c=>{
    if(c.cadence==='daily') wds.forEach(iso=>occ.push(mk(c,iso)));
    else if(c.cadence==='sprint-start') occ.push(mk(c,wds[0]));
    else if(c.cadence==='sprint-end') occ.push(mk(c,wds[wds.length-1]));
    else if(c.cadence==='weekly'){
      const weeks={}; wds.forEach(iso=>{ const wk=schedMonday(iso); (weeks[wk]=weeks[wk]||[]).push(iso); });
      Object.keys(weeks).sort().forEach(wk=>occ.push(mk(c, schedPickInWeek(weeks[wk], c.weekday))));
    }
    else if(c.cadence==='biweekly'){
      if(c.anchor){   // fixed-date anchor: absolute fortnightly cadence
        schedBiweeklyFromAnchor(c.anchor, win.start, win.end).forEach(iso=>occ.push(mk(c, iso)));
      } else {        // continuous every-other-week, phased to the current sprint's first week
        const anchorMon=phaseMon || schedMonday(win.start);
        const weeks={}; wds.forEach(iso=>{ const wk=schedMonday(iso); (weeks[wk]=weeks[wk]||[]).push(iso); });
        Object.keys(weeks).sort().forEach(wk=>{
          if(((schedWeeksBetween(anchorMon, wk)%2)+2)%2!==0) return;   // only even-offset weeks
          occ.push(mk(c, schedPickInWeek(weeks[wk], c.weekday)));
        });
      }
    }
  });
  return occ;
}
function schedSortOcc(occ){ occ.sort((a,b)=> a.date<b.date?-1 : a.date>b.date?1 : schedCerOrder(a.key)-schedCerOrder(b.key)); return occ; }
// Current sprint only (unchanged behaviour).
function schedOccurrences(){
  const t=at(); if(!t || !t.cfg || !t.cfg.startDate || !t.cfg.endDate) return [];
  const phaseMon=schedMonday(t.cfg.startDate);
  return schedSortOcc(schedOccForWindow(schedCfg(), {start:t.cfg.startDate, end:t.cfg.endDate, idx:0}, phaseMon));
}
// Current sprint plus projected future sprints out to the horizon.
function schedOccurrencesH(horizonMonths){
  const t=at(), cfg=schedCfg(); let occ=[];
  const phaseMon=(t&&t.cfg&&t.cfg.startDate)?schedMonday(t.cfg.startDate):null;
  schedWindows(horizonMonths).forEach(w=>{ occ=occ.concat(schedOccForWindow(cfg, w, phaseMon)); });
  return schedSortOcc(occ);
}

// ── AVAILABILITY ───────────────────────────────────────────────
// Unavailable if the date is one of the member's PTO dates (the shared source of
// truth set in the Capacity Planner), or falls in a legacy leave range.
function schedAvail(m, iso){
  if(m.ptoDates && m.ptoDates.indexOf(iso)>=0) return false;
  if(m.leave && m.leave.some(r=>{ if(!r.from) return false; const to=r.to||r.from; return iso>=r.from && iso<=to; })) return false;
  return true;
}
// m is eligible to lead ceremony `key` unless explicitly excluded.
function schedEligible(m, key){ return !(m.exclude && m.exclude.indexOf(key)>=0); }
// Shared PTO helper (also used by the Capacity Planner via ptoN): count of a
// member's specific PTO dates that are working days inside the sprint window,
// falling back to the legacy typed count when no dates are set.
function mbrPtoCount(m){
  const full=m.ptoDates||[], half=m.ptoHalf||[];
  if(!full.length && !half.length) return m.pto||0;   // legacy fallback
  const t=at(), s=t&&t.cfg&&t.cfg.startDate, e=t&&t.cfg&&t.cfg.endDate;
  const holSet=new Set((holidays||[]).map(h=>h.date));
  const inWD=d=>{ if(s&&e&&(d<s||d>e)) return false; const dt=new Date(d+'T00:00:00'); const dow=dt.getDay(); return dow!==0&&dow!==6&&!holSet.has(d); };
  const cf=(s&&e)?full.filter(inWD).length:full.length;
  const ch=(s&&e)?half.filter(inWD).length:half.length;
  return cf + 0.5*ch;   // half days count as 0.5
}

// ── ROSTER (planner members + scheduler-only people) ───────────
// Scheduler-only people live on team.sched.extraPeople with the same shape as a
// member (name, ptoDates, exclude) so the engine treats everyone uniformly.
function schedExtra(){ const s=schedCfg(); if(s && !Array.isArray(s.extraPeople)) s.extraPeople=[]; return s?s.extraPeople:[]; }
function schedRoster(){
  const t=at(); const mem=((t&&t.members)||[]).filter(m=>m.name && m.name.trim());
  return mem.concat(schedExtra());
}

// ── ROTATION ENGINE (least-loaded-available, per ceremony) ─────
function schedBuild(horizonMonths){
  const members=schedRoster();
  const occ=(horizonMonths>0)?schedOccurrencesH(horizonMonths):schedOccurrences();
  const counts={}, last={};   // counts[key][name]=n ; last[key][name]=occurrence index
  const pick=(key, pool)=>{   // member with fewest leads; tie: led least recently; tie: team order
    let best=null;
    pool.forEach((m,order)=>{
      const c=(counts[key]&&counts[key][m.name])||0;
      const l=(last[key]&&last[key][m.name]!=null)?last[key][m.name]:-1;
      if(!best){ best={m,c,l,order}; return; }
      if(c<best.c || (c===best.c && l<best.l)){ best={m,c,l,order}; }
    });
    return best?best.m:null;
  };
  const ov=(schedCfg().overrides)||{};
  const rows=occ.map((o,idx)=>{
    const okey=o.date+'|'+o.key;
    let assigned=null, coverFor=null, pinned=false, pinnedOnLeave=false;
    const ovMember = ov[okey] ? members.find(m=>m.name===ov[okey]) : null;
    if(ovMember){                                   // manual pin overrides the rotation
      assigned=ovMember; pinned=true; pinnedOnLeave=!schedAvail(ovMember,o.date);
    } else {
      const eligible=members.filter(m=>schedEligible(m,o.key));   // only members allowed to lead this ceremony
      const present=eligible.filter(m=>schedAvail(m,o.date));
      assigned=present.length?pick(o.key,present):null;
      const natural=eligible.length?pick(o.key,eligible):null;    // who it would be ignoring leave
      if(assigned && natural && natural.name!==assigned.name && !schedAvail(natural,o.date)) coverFor=natural.name;
    }
    if(assigned){                                   // pins count toward fairness so the rest balances around them
      (counts[o.key]=counts[o.key]||{})[assigned.name]=((counts[o.key]||{})[assigned.name]||0)+1;
      (last[o.key]=last[o.key]||{})[assigned.name]=idx;
    }
    return {date:o.date, key:o.key, name:o.name, sprint:o.sprint||0, assigned:assigned?assigned.name:null, coverFor, pinned, pinnedOnLeave};
  });
  return {rows, counts, members, occ};
}

// ── RENDER ─────────────────────────────────────────────────────
function renderScheduler(){
  const host=q('#sched-body'); if(!host) return;
  const t=at();
  if(!t){ host.innerHTML='<div class="sch-empty"><div class="sch-empty-ico">📅</div><h4>No team selected</h4></div>'; return; }
  if(!t.cfg.startDate || !t.cfg.endDate){
    host.innerHTML='<div class="sch-empty"><div class="sch-empty-ico">🗓</div><h4>Set the sprint dates</h4>'+
      '<p>Set a Start and End date in the Sprint Capacity Planner so the scheduler knows the sprint window.</p></div>';
    return;
  }
  host.innerHTML=
    schedRenderConfig()+
    schedRenderRoster()+
    schedRenderEligibility(schedRoster())+
    schedRenderRota()+
    schedRenderFair();
}
function schedRenderEligibility(members){
  const cers=schedCfg().ceremonies.filter(c=>c.enabled);
  if(!cers.length) return '';
  const head='<tr><th>Person</th>'+cers.map(c=>'<th style="text-align:center">'+esc(c.name)+'</th>').join('')+'</tr>';
  const rows=members.map((m,i)=>{
    const cells=cers.map(c=>'<td class="num"><input type="checkbox" class="sch-chk" '+(schedEligible(m,c.key)?'checked':'')+
      ' onchange="schedSetEligible('+i+',\''+c.key+'\',this.checked)"></td>').join('');
    return '<tr><td style="font-weight:600;color:var(--text)">'+esc(m.name)+'</td>'+cells+'</tr>';
  }).join('');
  // warn about any ceremony with nobody eligible
  const orphan=cers.filter(c=>!members.some(m=>schedEligible(m,c.key))).map(c=>c.name);
  const warn=orphan.length?'<div class="sch-warn" style="margin-top:10px">⚠ <span>No one is eligible to lead: '+esc(orphan.join(', '))+'. Those slots will show "needs cover".</span></div>':'';
  return '<div class="sc" style="margin-bottom:16px"><div class="sc-bar"><span class="sc-badge b5">Eligibility</span><span class="sc-title">Who can lead what</span></div>'+
    '<div class="sc-body"><div class="sch-hint">Tick who is allowed to lead each ceremony. Everyone is eligible by default; untick to opt someone out (a manual pin can still override this).</div>'+
    '<table class="sch-fair-tbl"><thead>'+head+'</thead><tbody>'+rows+'</tbody></table>'+warn+'</div></div>';
}
function schedSetEligible(i, key, checked){
  const m=schedRoster()[i]; if(!m) return;   // roster index: member or scheduler-only person
  m.exclude=m.exclude||[];
  if(checked) m.exclude=m.exclude.filter(k=>k!==key);
  else if(m.exclude.indexOf(key)<0) m.exclude.push(key);
  if(typeof dSave==='function') dSave();
  renderScheduler();
}

function schedRenderConfig(){
  const cfg=schedCfg();
  const cad=[['daily','Every working day'],['weekly','Weekly'],['biweekly','Bi-weekly'],['sprint-start','Sprint start'],['sprint-end','Sprint end']];
  let rows=cfg.ceremonies.map(c=>{
    const cadSel='<select onchange="schedSetCer(\''+c.key+'\',\'cadence\',this.value)">'+
      cad.map(o=>'<option value="'+o[0]+'"'+(c.cadence===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
    const showWd = c.cadence==='weekly' || (c.cadence==='biweekly' && !c.anchor);   // anchor defines its own weekday
    const wdSel = showWd ? '<label class="fl">on</label><select onchange="schedSetCer(\''+c.key+'\',\'weekday\',this.value)">'+
      [1,2,3,4,5].map(d=>'<option value="'+d+'"'+(c.weekday===d?' selected':'')+'>'+SCHED_DOW[d]+'</option>').join('')+'</select>' : '';
    const anchorInp = (c.cadence==='biweekly') ? '<label class="fl">starting</label>'+
      '<input type="date" class="sch-anchor" value="'+esc(c.anchor||'')+'" title="Date of the next occurrence; the fortnightly cadence steps 14 days from here" onchange="schedSetCer(\''+c.key+'\',\'anchor\',this.value)">'+
      (c.anchor?'<button class="sch-anchor-clr" title="Clear anchor (fall back to sprint-aligned)" onclick="schedSetCer(\''+c.key+'\',\'anchor\',\'\')">✕</button>':'') : '';
    return '<div class="sch-cer'+(c.enabled?'':' off')+'">'+
      '<input type="checkbox" class="sch-chk" '+(c.enabled?'checked':'')+' onchange="schedSetCer(\''+c.key+'\',\'enabled\',this.checked)">'+
      '<span class="sch-cer-name">'+esc(c.name)+'</span>'+
      '<label class="fl">Cadence</label>'+cadSel+wdSel+anchorInp+'</div>';
  }).join('');
  return '<div class="sc" style="margin-bottom:16px"><div class="sc-bar"><span class="sc-badge b5">Ceremonies</span><span class="sc-title">Ceremony settings</span></div>'+
    '<div class="sc-body">'+rows+'</div></div>';
}

// Roster + leave. Members come from the Planner (leave read-only, from their PTO);
// scheduler-only people are editable here, and new people can be added.
function schedRenderRoster(){
  const t=at(), s=t.cfg.startDate, e=t.cfg.endDate;
  const mem=((t&&t.members)||[]).filter(m=>m.name&&m.name.trim());
  const extra=schedExtra();
  const leaveChips=p=>{
    const full=(p.ptoDates||[]).filter(d=>d>=s&&d<=e).sort().map(d=>'<span class="sch-lv-chip">'+esc(schedShort(d))+'</span>');
    const half=(p.ptoHalf||[]).filter(d=>d>=s&&d<=e).sort().map(d=>'<span class="sch-lv-chip">'+esc(schedShort(d))+' ½</span>');
    const all=full.concat(half);
    return all.length?all.join(''):'<span style="font-size:11px;color:var(--hint)">Available all sprint</span>';
  };
  const memRows=mem.map(m=>{
    return '<tr><td style="font-weight:600;color:var(--text);white-space:nowrap">'+esc(m.name)+'<span class="sch-src">planner</span></td>'+
      '<td><div class="sch-lv-chips">'+leaveChips(m)+'</div></td></tr>';
  }).join('');
  const extraRows=extra.map((p,xi)=>{
    const chips=leaveChips(p);
    return '<tr><td style="font-weight:600;color:var(--text);white-space:nowrap">'+esc(p.name)+'<span class="sch-src">scheduler</span></td>'+
      '<td><div class="sch-lv-chips">'+chips+'</div>'+
      '<div class="sch-lv-add"><button class="pto-btn" onclick="schedOpenExtraPto('+xi+')">'+(mbrPtoCount(p))+' 📅 Pick leave</button>'+
      '<button class="btn btn-ghost btn-sm" onclick="schedRemovePerson('+xi+')" title="Remove from roster">Remove</button></div></td></tr>';
  }).join('');
  const empty=(!mem.length&&!extra.length)?'<tr><td colspan="2"><span style="font-size:12px;color:var(--hint)">No one on the roster yet. Add people below, or add members in the Sprint Capacity Planner.</span></td></tr>':'';
  return '<div class="sc" style="margin-bottom:16px"><div class="sc-bar"><span class="sc-badge b5">Roster</span><span class="sc-title">People and leave</span></div>'+
    '<div class="sc-body"><div class="sch-hint">Members come from the Sprint Capacity Planner, with leave taken from their PTO dates. You can also add scheduler-only people here who do not need to be in the planner.</div>'+
    '<table class="sch-lv-tbl"><thead><tr><th>Person</th><th>Leave this sprint</th></tr></thead><tbody>'+memRows+extraRows+empty+'</tbody></table>'+
    '<div class="sch-lv-add" style="margin-top:10px"><input type="text" id="sch-newperson" placeholder="New person name" onkeydown="if(event.key===\'Enter\')schedAddPerson()"><button class="btn btn-primary btn-sm" onclick="schedAddPerson()">+ Add person</button></div>'+
    '</div></div>';
}
function schedShort(iso){ const d=new Date(iso+'T00:00:00'); return d.getDate()+' '+SCHED_MON[d.getMonth()]; }
function schedAddPerson(){
  const el=q('#sch-newperson'); const name=(el&&el.value||'').trim();
  if(!name){ if(typeof showToast==='function') showToast('Enter a name','a'); return; }
  schedExtra().push({name, ptoDates:[], exclude:[]});
  if(typeof dSave==='function') dSave();
  renderScheduler();
  if(typeof showToast==='function') showToast(name+' added to the roster','g');
}
function schedRemovePerson(xi){ schedExtra().splice(xi,1); if(typeof dSave==='function') dSave(); renderScheduler(); }
// Open the shared Capacity-Planner PTO calendar for a scheduler-only person.
function schedOpenExtraPto(xi){
  const p=schedExtra()[xi]; if(!p) return;
  if(typeof openPto==='function') openPto(p, {name:p.name, onChange:function(){ if(typeof dSave==='function') dSave(); renderScheduler(); }});
  else if(typeof showToast==='function') showToast('Calendar unavailable','r');
}

function schedRenderRota(){
  const built=schedBuild(schedHorizon);
  const hzOpts=[[0,'This sprint'],[3,'+3 months'],[6,'+6 months'],[12,'+12 months']];
  const hzSel='<label class="fl">Look ahead</label><select class="sch-hz-sel" onchange="schedSetHorizon(this.value)">'+
    hzOpts.map(o=>'<option value="'+o[0]+'"'+(schedHorizon===o[0]?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>';
  const head='<div class="sc-bar"><span class="sc-badge b5">Rota</span><span class="sc-title">Schedule</span>'+
    '<div class="sc-acts">'+
      '<button class="btn btn-ghost btn-sm'+(schedView==='ceremony'?' active':'')+'" onclick="schedSetView(\'ceremony\')">By ceremony</button>'+
      '<button class="btn btn-ghost btn-sm'+(schedView==='list'?' active':'')+'" onclick="schedSetView(\'list\')">By week</button>'+
      '<button class="btn btn-ghost btn-sm'+(schedView==='calendar'?' active':'')+'" onclick="schedSetView(\'calendar\')">Calendar</button>'+
      '<span style="width:8px"></span>'+hzSel+
      '<span style="width:8px"></span>'+
      '<button class="btn btn-ghost btn-sm" onclick="schedExportCSV()">CSV</button>'+
      '<button class="btn btn-ghost btn-sm" onclick="schedExportICS()">Calendar (.ics)</button>'+
      '<button class="btn btn-ghost btn-sm" onclick="schedCopySlack()">Copy for Slack</button>'+
    '</div></div>';
  if(!built.occ.length){
    return '<div class="sc" style="margin-bottom:16px">'+head+
      '<div class="sc-body"><div class="sch-warn">⚠ <span>No ceremonies scheduled. Enable at least one ceremony, and check the sprint has working days.</span></div></div></div>';
  }
  const gaps=built.rows.filter(r=>r.sprint===0 && !r.assigned).length;
  const note=gaps?'<div class="sch-warn" style="margin-bottom:12px">⚠ <span>'+gaps+' slot'+(gaps===1?'':'s')+' have no available facilitator (everyone on leave). Pin someone or adjust leave.</span></div>':'';
  const proj=schedHorizon>0?'<div class="sch-hint" style="margin-bottom:12px">Sprint 2 onward is projected: back-to-back sprints of the same length and cadence, with the rotation continuing for fairness. PTO and pins only apply to the current sprint, so projected slots assume everyone is available.</div>':'';
  const body = schedView==='calendar' ? schedRenderCalendar(built)
             : schedView==='list' ? schedRenderList(built)
             : schedRenderCeremonyCols(built);
  return '<div class="sc" style="margin-bottom:16px">'+head+'<div class="sc-body">'+note+proj+body+'</div></div>';
}
function schedLeadSelect(r, members){
  return '<select class="sch-lead-sel" onchange="schedSetOverride(\''+r.date+'\',\''+r.key+'\',this.value)">'+
    '<option value="">Auto</option>'+
    members.map(m=>'<option value="'+esc(m.name)+'"'+(r.assigned===m.name?' selected':'')+'>'+esc(m.name)+'</option>').join('')+
    '</select>';
}
function schedRowBadges(r){
  return (r.pinned?'<span class="sch-pin" title="Pinned override">📌</span>':'')+
    (r.coverFor?'<span class="sch-cover">covering for '+esc(r.coverFor)+'</span>':'')+
    (r.pinnedOnLeave?'<span class="sch-cover" style="color:var(--red);background:var(--red-bg);border-color:var(--red-bd)">pinned, on leave</span>':'')+
    (!r.assigned?'<span class="sch-nocover">⚠ needs cover</span>':'');
}
function schedSprintTag(sprint){ return sprint>0?'<span class="sch-proj-tag">Sprint '+(sprint+1)+' · projected</span>':''; }
function schedRenderList(built){
  const members=built.members, weeks={};
  built.rows.forEach(r=>{ const wk=schedMonday(r.date); (weeks[wk]=weeks[wk]||[]).push(r); });
  return Object.keys(weeks).sort().map(wk=>{
    const sprint=weeks[wk][0].sprint||0, proj=sprint>0;
    const rowsHtml=weeks[wk].map(r=>
      '<div class="sch-row"><span class="sch-date">'+schedFmt(r.date)+'</span>'+
      '<span><span class="sch-cer-badge '+schedCerClass(r.key)+'">'+esc(r.name)+'</span></span>'+
      '<span class="sch-lead-cell">'+schedLeadSelect(r,members)+schedRowBadges(r)+'</span></div>'
    ).join('');
    return '<div class="sch-week'+(proj?' proj':'')+'"><div class="sch-week-hd">'+schedWeekLabel(wk)+schedSprintTag(sprint)+'</div>'+rowsHtml+'</div>';
  }).join('');
}
// One column per ceremony, each independently copyable for Slack.
function schedRenderCeremonyCols(built){
  const members=built.members;
  const byKey={}; built.rows.forEach(r=>{ (byKey[r.key]=byKey[r.key]||[]).push(r); });
  const cols=schedCfg().ceremonies.filter(c=>c.enabled && (byKey[c.key]||[]).length).map(c=>{
    const rows=byKey[c.key];
    const gaps=rows.filter(r=>r.sprint===0 && !r.assigned).length;
    let seen=-1;
    const rowsHtml=rows.map(r=>{
      const sep=(r.sprint>seen && r.sprint>0)?'<div class="sch-crow-sep">Sprint '+(r.sprint+1)+' · projected</div>':'';
      seen=Math.max(seen,r.sprint);
      return sep+'<div class="sch-crow'+(r.sprint>0?' proj':'')+'"><span class="sch-date">'+schedFmt(r.date)+'</span>'+
      '<span class="sch-lead-cell">'+schedLeadSelect(r,members)+schedRowBadges(r)+'</span></div>';
    }).join('');
    return '<div class="sch-cer-col">'+
      '<div class="sch-cer-col-hd">'+
        '<span class="sch-cer-badge '+schedCerClass(c.key)+'">'+esc(c.name)+'</span>'+
        '<button class="btn btn-ghost btn-sm" onclick="schedCopyCeremony(\''+c.key+'\')" title="Copy this ceremony for Slack">Copy</button>'+
      '</div>'+
      (gaps?'<div class="sch-col-warn">'+gaps+' need cover</div>':'')+
      '<div class="sch-cer-col-body">'+rowsHtml+'</div></div>';
  }).join('');
  return '<div class="sch-cer-grid">'+cols+'</div>'+
    '<div class="sch-hint" style="margin-top:12px">Each ceremony copies on its own, ready to paste into Slack. Use the dropdowns to reassign or pin a facilitator.</div>';
}
function schedMonthIdx(iso){ const d=new Date(iso+'T00:00:00'); return d.getFullYear()*12+d.getMonth(); }
// Month range the calendar can page across: sprint start .. end of the last projected sprint.
function schedCalBounds(){
  const wins=schedWindows(schedHorizon);
  if(!wins.length){ const t=at(); const i=(t&&t.cfg&&t.cfg.startDate)?schedMonthIdx(t.cfg.startDate):0; return {minIdx:i, maxIdx:i}; }
  return {minIdx:schedMonthIdx(wins[0].start), maxIdx:schedMonthIdx(wins[wins.length-1].end)};
}
// One calendar month at a time; navigate across every month in the look-ahead range.
function schedRenderCalendar(built){
  const bnd=schedCalBounds(), minIdx=bnd.minIdx, maxIdx=bnd.maxIdx;
  if(schedCalIdx==null || schedCalIdx<minIdx || schedCalIdx>maxIdx) schedCalIdx=minIdx;
  const idx=schedCalIdx, year=Math.floor(idx/12), month=idx%12;
  const byDate={}; built.rows.forEach(r=>{ (byDate[r.date]=byDate[r.date]||[]).push(r); });
  // grid: Monday of the week containing the 1st -> Sunday of the week containing the last day
  const gridStart=new Date(schedMonday(schedISO(new Date(year,month,1)))+'T00:00:00');
  const lastMon=new Date(schedMonday(schedISO(new Date(year,month+1,0)))+'T00:00:00');
  const gridEnd=new Date(lastMon); gridEnd.setDate(gridEnd.getDate()+6);
  const nav='<div class="sch-cal-nav">'+
    '<button class="btn btn-ghost btn-sm" onclick="schedCalNav(-1)"'+(idx<=minIdx?' disabled':'')+' title="Previous month">‹</button>'+
    '<span class="sch-cal-title">'+SCHED_MON[month]+' '+year+'</span>'+
    '<button class="btn btn-ghost btn-sm" onclick="schedCalNav(1)"'+(idx>=maxIdx?' disabled':'')+' title="Next month">›</button>'+
    '</div>';
  const hdr='<div class="sch-cal-grid sch-cal-hd">'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=>'<div class="sch-cal-dow">'+d+'</div>').join('')+'</div>';
  let cells='', cur=new Date(gridStart), guard=0;
  while(cur<=gridEnd && guard++<45){
    const iso=schedISO(cur), d=new Date(cur), inMonth=d.getMonth()===month, dayRows=byDate[iso]||[];
    const scheduled=dayRows.length>0, proj=dayRows.some(r=>r.sprint>0);
    const chips=dayRows.map(r=>'<div class="sch-cal-chip '+schedCerClass(r.key)+(r.pinned?' pinned':'')+'" title="'+esc(r.name)+': '+esc(r.assigned||'needs cover')+(r.coverFor?' (covering for '+esc(r.coverFor)+')':'')+'">'+
      (r.pinned?'📌':'')+esc(r.assigned||'-')+'</div>').join('');
    cells+='<div class="sch-cal-cell'+(inMonth?'':' out')+(scheduled?' insprint':'')+(proj?' proj':'')+'"><div class="sch-cal-num">'+d.getDate()+'</div>'+chips+'</div>';
    cur.setDate(cur.getDate()+1);
  }
  const hint=schedHorizon>0
    ? 'Dashed days carry ceremonies. Days with a violet corner are in a projected (future) sprint. Switch to By week to reassign or pin within the current sprint.'
    : 'Dashed days are inside the sprint. Ceremonies only run during the sprint window; switch to By week to reassign or pin a facilitator.';
  return nav+hdr+'<div class="sch-cal-grid">'+cells+'</div>'+
    '<div class="sch-hint" style="margin-top:10px">'+hint+'</div>';
}
function schedCalNav(delta){
  const bnd=schedCalBounds();
  const base=(schedCalIdx==null?bnd.minIdx:schedCalIdx);
  schedCalIdx=Math.max(bnd.minIdx, Math.min(bnd.maxIdx, base+delta));
  renderScheduler();
}
function schedSetHorizon(v){ schedHorizon=+v||0; schedCalIdx=null; renderScheduler(); }
function schedSetView(v){ schedView=v; renderScheduler(); }

function schedRenderFair(){
  const built=schedBuild();
  const cfg=schedCfg(), cers=cfg.ceremonies.filter(c=>c.enabled);
  if(!built.members.length || !cers.length) return '';
  let head='<tr><th>Member</th>'+cers.map(c=>'<th style="text-align:center">'+esc(c.name)+'</th>').join('')+'<th style="text-align:center">Total</th></tr>';
  let rows=built.members.map(m=>{
    let tot=0;
    const cells=cers.map(c=>{ const n=(built.counts[c.key]&&built.counts[c.key][m.name])||0; tot+=n; return '<td class="num">'+n+'</td>'; }).join('');
    return '<tr><td style="font-weight:600;color:var(--text)">'+esc(m.name)+'</td>'+cells+'<td class="tot">'+tot+'</td></tr>';
  }).join('');
  return '<div class="sc" style="margin-bottom:16px"><div class="sc-bar"><span class="sc-badge b5">Balance</span><span class="sc-title">Fairness - leads per member</span></div>'+
    '<div class="sc-body"><div class="sch-hint">How many times each member leads each ceremony this sprint. Leave-driven cover is included, so counts stay balanced over time.</div>'+
    '<table class="sch-fair-tbl"><thead>'+head+'</thead><tbody>'+rows+'</tbody></table></div></div>';
}

// ── HANDLERS ───────────────────────────────────────────────────
function schedSetCer(key, field, val){
  const cfg=schedCfg(); const c=cfg.ceremonies.find(x=>x.key===key); if(!c) return;
  if(field==='enabled') c.enabled=!!val;
  else if(field==='weekday') c.weekday=+val;
  else c[field]=val;
  if(typeof dSave==='function') dSave();
  renderScheduler();
}
function schedSetOverride(date, key, name){
  const cfg=schedCfg(); cfg.overrides=cfg.overrides||{};
  const okey=date+'|'+key;
  if(!name) delete cfg.overrides[okey]; else cfg.overrides[okey]=name;
  if(typeof dSave==='function') dSave();
  renderScheduler();
}

// ── EXPORT ─────────────────────────────────────────────────────
function schedRows(){ return schedBuild(schedHorizon).rows; }
function schedExportCSV(){
  const rows=schedRows(); if(!rows.length){ if(typeof showToast==='function') showToast('Nothing to export','a'); return; }
  const t=at();
  let csv='Date,Ceremony,Facilitator,Covering for\n';
  rows.forEach(r=>{ csv+=[r.date, r.name, r.assigned||'NEEDS COVER', r.coverFor||''].map(schedCsvCell).join(',')+'\n'; });
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})), a=document.createElement('a');
  a.href=url; a.download='ceremony-schedule-'+((t&&t.name)||'team').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.csv';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  if(typeof showToast==='function') showToast('Schedule exported','g');
}
function schedCsvCell(v){ v=String(v==null?'':v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }
// Build an RFC-5545 iCalendar string (all-day events, one per ceremony occurrence).
function schedBuildICS(rows, teamName, stamp){
  const esc=s=>String(s==null?'':s).replace(/[\\;,]/g,m=>'\\'+m).replace(/\n/g,'\\n');
  const nextDay=iso=>{ const d=new Date(iso+'T00:00:00'); d.setDate(d.getDate()+1); return schedISO(d).replace(/-/g,''); };
  const L=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Sprint Capacity//Ceremony Scheduler//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
  rows.forEach((r,i)=>{
    L.push('BEGIN:VEVENT');
    L.push('UID:'+r.date+'-'+r.key+'-'+i+'@sprint-capacity');
    L.push('DTSTAMP:'+stamp);
    L.push('DTSTART;VALUE=DATE:'+r.date.replace(/-/g,''));
    L.push('DTEND;VALUE=DATE:'+nextDay(r.date));
    L.push('SUMMARY:'+esc(r.name+' - '+(r.assigned||'NEEDS COVER')));
    L.push('DESCRIPTION:'+esc('Facilitator: '+(r.assigned||'needs cover')+(r.coverFor?' (covering for '+r.coverFor+')':'')+(r.pinned?' [pinned]':'')+'  ·  '+teamName));
    L.push('END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n');
}
function schedStamp(){ const n=new Date(), p=x=>String(x).padStart(2,'0');
  return n.getUTCFullYear()+p(n.getUTCMonth()+1)+p(n.getUTCDate())+'T'+p(n.getUTCHours())+p(n.getUTCMinutes())+p(n.getUTCSeconds())+'Z'; }
function schedExportICS(){
  const rows=schedRows(); if(!rows.length){ if(typeof showToast==='function') showToast('Nothing to export','a'); return; }
  const t=at(), ics=schedBuildICS(rows, (t&&t.name)||'Team', schedStamp());
  const url=URL.createObjectURL(new Blob([ics],{type:'text/calendar'})), a=document.createElement('a');
  a.href=url; a.download='ceremony-schedule-'+((t&&t.name)||'team').toLowerCase().replace(/[^a-z0-9]+/g,'-')+'.ics';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  if(typeof showToast==='function') showToast('Calendar (.ics) exported','g');
}
function schedClip(txt, okMsg){
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(
    ()=>{ if(typeof showToast==='function') showToast(okMsg||'Copied','g'); },
    ()=>{ if(typeof showToast==='function') showToast('Copy failed','r'); }); }
  else if(typeof showToast==='function') showToast('Clipboard unavailable','a');
}
// One line per occurrence, Slack-friendly.
function schedSlackLine(r){ return '• '+schedShort(r.date)+': '+(r.assigned||'NEEDS COVER')+(r.coverFor?' (covering for '+r.coverFor+')':''); }
// Copy the whole rota, grouped by ceremony so each block can be pasted on its own.
function schedCopySlack(){
  const built=schedBuild(schedHorizon), rows=built.rows; if(!rows.length) return;
  const t=at(), team=(t&&t.name)||'Team';
  const byKey={}; rows.forEach(r=>{ (byKey[r.key]=byKey[r.key]||[]).push(r); });
  let txt='*Ceremony schedule - '+team+'*\n';
  schedCfg().ceremonies.forEach(c=>{ const rs=byKey[c.key]; if(!rs||!rs.length) return;
    txt+='\n*'+c.name+'*\n'+rs.map(schedSlackLine).join('\n')+'\n'; });
  schedClip(txt, 'Copied full rota for Slack');
}
// Copy just one ceremony's rota so it can be shared individually.
function schedCopyCeremony(key){
  const built=schedBuild(schedHorizon);
  const rows=built.rows.filter(r=>r.key===key); if(!rows.length) return;
  const t=at(), team=(t&&t.name)||'Team';
  const name=(schedCfg().ceremonies.find(c=>c.key===key)||{}).name||key;
  const txt='*'+name+' - '+team+'*\n'+rows.map(schedSlackLine).join('\n');
  schedClip(txt, 'Copied '+name+' for Slack');
}
