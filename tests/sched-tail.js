// ── Scheduler engine assertions ──
var pass=0, fail=0;
function assert(name, cond, got){ if(cond){pass++; LOG('PASS  '+name);} else {fail++; LOG('FAIL  '+name+'   (got: '+got+')');} }
LOG('=== Ceremony scheduler engine ===');

_team.sched=null;                       // force defaults
var occ=schedOccurrences();
var cnt=function(k){ return occ.filter(function(o){return o.key===k;}).length; };
assert('10 standups (working days)', cnt('standup')===10, cnt('standup'));
assert('2 refinements (weekly Tue)', cnt('refinement')===2, cnt('refinement'));
assert('2 groomings (weekly Thu)', cnt('grooming')===2, cnt('grooming'));
assert('1 retrospective (sprint end)', cnt('retro')===1, cnt('retro'));
assert('1 sprint demo (sprint end)', cnt('demo')===1, cnt('demo'));
var retro=occ.filter(function(o){return o.key==='retro';})[0];
var demo=occ.filter(function(o){return o.key==='demo';})[0];
assert('retro on last working day (13 Mar)', retro.date==='2026-03-13', retro.date);
assert('demo on last working day (13 Mar)', demo.date==='2026-03-13', demo.date);
assert('demo is ordered before retro on the shared day', schedCerOrder('demo')<schedCerOrder('retro'), schedCerOrder('demo')+'/'+schedCerOrder('retro'));
// migration: a legacy config without Demo gets it seeded before retro
_team.sched={ceremonies:[{key:'standup',name:'Daily Standup',cadence:'daily',weekday:null,enabled:true},{key:'retro',name:'Retrospective',cadence:'sprint-end',weekday:null,enabled:true}]};
var cfgM=schedCfg();
assert('migration seeds Demo for legacy configs', cfgM.ceremonies.some(function(c){return c.key==='demo';}), 'no demo');
assert('migrated Demo sits before retro', cfgM.ceremonies.findIndex(function(c){return c.key==='demo';})<cfgM.ceremonies.findIndex(function(c){return c.key==='retro';}), 'order');
_team.sched=null; schedCfg();           // restore defaults for later tests
var ref=occ.filter(function(o){return o.key==='refinement';}).map(function(o){return o.date;});
assert('refinements land on Tuesdays', ref.join(',')==='2026-03-03,2026-03-10', ref.join(','));

// biweekly cadence: every other week -> half the weekly count over a 2-week sprint
var refCer=_team.sched.ceremonies.find(function(c){return c.key==='refinement';});
refCer.cadence='biweekly';
var bw=schedOccurrences().filter(function(o){return o.key==='refinement';});
assert('biweekly refinement = 1 (every other week)', bw.length===1, bw.length);
assert('biweekly lands on the first eligible week (Tue 3 Mar)', bw[0].date==='2026-03-03', bw[0].date);
refCer.cadence='weekly';

// ── Future-sprint projection (look-ahead) ──
var wins=schedWindows(3);
assert('projection yields multiple sprints for +3mo', wins.length>1, wins.length);
assert('first window is the real sprint', wins[0].start==='2026-03-02'&&wins[0].end==='2026-03-13', wins[0].start+'..'+wins[0].end);
assert('sprint 2 starts the next working day (Mon 16 Mar)', wins[1].start==='2026-03-16', wins[1].start);
assert('projected sprints keep the same working-day length', schedWorkingDays(wins[1].start,wins[1].end).length===10, schedWorkingDays(wins[1].start,wins[1].end).length);
var occH=schedOccurrencesH(3);
assert('projected occurrences extend past sprint end', occH.some(function(o){return o.date>'2026-03-13';}), 'no future');
assert('projected occurrences carry a sprint index', occH.some(function(o){return o.sprint>0;}), 'no sprint tag');
var bH=schedBuild(3);
assert('projected build has future rows', bH.rows.some(function(r){return r.sprint>0;}), 'no proj rows');
var svH=_team.members.map(function(m){return (bH.counts.standup[m.name]||0);});
assert('rotation stays fair across projected sprints', Math.max.apply(null,svH)-Math.min.apply(null,svH)<=1, svH.join(','));
assert('no-arg build stays current-sprint only', schedBuild().rows.every(function(r){return r.sprint===0;}), 'leaked future rows');
schedHorizon=3;
var bnd=schedCalBounds();
assert('calendar bounds widen with the horizon', bnd.maxIdx>schedMonthIdx('2026-03-13'), bnd.maxIdx);
schedHorizon=0;
var bnd0=schedCalBounds();
assert('calendar bounds collapse to the sprint with no horizon', bnd0.minIdx===bnd0.maxIdx && bnd0.minIdx===schedMonthIdx('2026-03-02'), bnd0.minIdx+'/'+bnd0.maxIdx);

// ── Bi-weekly with a fixed anchor date (absolute fortnight, sprint-independent) ──
var refA=_team.sched.ceremonies.find(function(c){return c.key==='refinement';});
refA.cadence='biweekly'; refA.anchor='2026-03-03';   // Tue in the sprint's opening week
var occA=schedOccurrences().filter(function(o){return o.key==='refinement';}).map(function(o){return o.date;});
assert('anchor biweekly lands on the anchor date', occA.join(',')==='2026-03-03', occA.join(','));
var occAH=schedOccurrencesH(3).filter(function(o){return o.key==='refinement';}).map(function(o){return o.date;});
var okGap=occAH.length>=3; for(var gi=0;gi<occAH.length-1;gi++){ if(Math.round((new Date(occAH[gi+1])-new Date(occAH[gi]))/86400000)!==14) okGap=false; }
assert('anchor biweekly keeps exact 14-day spacing across projected sprints', okGap, occAH.slice(0,5).join(','));
assert('anchor biweekly steps a fortnight past the anchor (17 Mar)', occAH.indexOf('2026-03-17')>=0, occAH.slice(0,5).join(','));
// a mid-week-start sprint must not break the cadence (regression for the old per-window reset)
var savedS=_team.cfg.startDate, savedE=_team.cfg.endDate;
_team.cfg.startDate='2026-03-04'; _team.cfg.endDate='2026-03-17';   // starts Wed, mid-week
var occMid=schedOccurrencesH(2).filter(function(o){return o.key==='refinement';}).map(function(o){return o.date;});
var okMid=occMid.length>=2; for(var mi=0;mi<occMid.length-1;mi++){ if(Math.round((new Date(occMid[mi+1])-new Date(occMid[mi]))/86400000)!==14) okMid=false; }
assert('anchor biweekly stays 14-day apart even for a mid-week sprint start', okMid, occMid.slice(0,5).join(','));
_team.cfg.startDate=savedS; _team.cfg.endDate=savedE;
// clearing the anchor falls back to the sprint-aligned even-week cadence
refA.anchor='';
var occN=schedOccurrences().filter(function(o){return o.key==='refinement';});
assert('no-anchor biweekly = 1 occurrence in the 2-week sprint (opening week)', occN.length===1 && occN[0].date==='2026-03-03', occN.map(function(o){return o.date;}).join(','));
refA.cadence='weekly'; delete refA.anchor;

// fairness with no leave
var b=schedBuild();
var vals=_team.members.map(function(m){return (b.counts.standup[m.name]||0);});
assert('standup leads balanced (max-min<=1)', Math.max.apply(null,vals)-Math.min.apply(null,vals)<=1, vals.join(','));
assert('every standup assigned (no leave)', b.rows.filter(function(r){return r.key==='standup'&&!r.assigned;}).length===0, 'gaps');
LOG('  standup leads: '+_team.members.map(function(m){return m.name+' '+(b.counts.standup[m.name]||0);}).join(', '));

// availability helper
_team.members[0].leave=[{from:'2026-03-02',to:'2026-03-02'}];
assert('schedAvail false on a leave day', schedAvail(_team.members[0],'2026-03-02')===false, 'avail');
assert('schedAvail true off leave', schedAvail(_team.members[0],'2026-03-03')===true, 'avail');

// leave-aware reassignment: Alice out on the first standup day
var b2=schedBuild();
var mar2=b2.rows.filter(function(r){return r.date==='2026-03-02'&&r.key==='standup';})[0];
assert('leave: Alice not assigned on her day off', mar2.assigned!=='Alice', mar2.assigned);
assert('leave: slot still covered', !!mar2.assigned, mar2.assigned);
assert('leave: badge shows covering for Alice', mar2.coverFor==='Alice', mar2.coverFor);
// fairness still balanced across the sprint despite the leave
var vals2=_team.members.map(function(m){return (b2.counts.standup[m.name]||0);});
assert('leave: leads still balanced overall', Math.max.apply(null,vals2)-Math.min.apply(null,vals2)<=1, vals2.join(','));

// whole team out on a day -> needs cover
_team.members.forEach(function(m){ m.leave=[{from:'2026-03-02',to:'2026-03-02'}]; });
var b3=schedBuild();
var mar2b=b3.rows.filter(function(r){return r.date==='2026-03-02'&&r.key==='standup';})[0];
assert('all-out day flagged as needs cover', mar2b.assigned===null, mar2b.assigned);
_team.members.forEach(function(m){ delete m.leave; });

// holidays excluded from working days
holidays=[{date:'2026-03-02',name:'Test holiday'}];
assert('holiday drops a standup (now 9)', schedOccurrences().filter(function(o){return o.key==='standup';}).length===9, schedOccurrences().filter(function(o){return o.key==='standup';}).length);
holidays=[];

// disabling a ceremony removes its occurrences
_team.sched.ceremonies.find(function(c){return c.key==='retro';}).enabled=false;
assert('disabled ceremony produces no occurrences', schedOccurrences().filter(function(o){return o.key==='retro';}).length===0, 'retro still present');

// ── P2: overrides / pins ──
_team.sched.ceremonies.find(function(c){return c.key==='retro';}).enabled=true;   // re-enable
_team.sched.overrides={'2026-03-03|standup':'Carol'};
var bo=schedBuild();
var pinRow=bo.rows.filter(function(r){return r.date==='2026-03-03'&&r.key==='standup';})[0];
assert('override assigns the pinned member', pinRow.assigned==='Carol', pinRow.assigned);
assert('override marks the slot pinned', pinRow.pinned===true, pinRow.pinned);
assert('pinned lead counts toward fairness', (bo.counts.standup['Carol']||0)>=1, bo.counts.standup['Carol']);
// pin someone who's on leave that day
_team.members[2].leave=[{from:'2026-03-03',to:'2026-03-03'}];   // Carol out 3 Mar
var bo2=schedBuild();
var pinRow2=bo2.rows.filter(function(r){return r.date==='2026-03-03'&&r.key==='standup';})[0];
assert('pinned-on-leave still assigned', pinRow2.assigned==='Carol', pinRow2.assigned);
assert('pinned-on-leave flagged', pinRow2.pinnedOnLeave===true, pinRow2.pinnedOnLeave);
delete _team.members[2].leave;
// clearing the override returns to auto
_team.sched.overrides={};
var bo3=schedBuild();
var autoRow=bo3.rows.filter(function(r){return r.date==='2026-03-03'&&r.key==='standup';})[0];
assert('cleared override is no longer pinned', autoRow.pinned===false, autoRow.pinned);

// ── P2: ICS export ──
var ics=schedBuildICS(bo3.rows,'Test Team','20260702T000000Z');
assert('ICS starts with VCALENDAR', ics.indexOf('BEGIN:VCALENDAR')===0, ics.slice(0,20));
assert('ICS ends with VCALENDAR', ics.indexOf('END:VCALENDAR')===ics.length-'END:VCALENDAR'.length, 'bad end');
var vevents=(ics.match(/BEGIN:VEVENT/g)||[]).length;
assert('ICS has one VEVENT per occurrence', vevents===bo3.rows.length, vevents+' vs '+bo3.rows.length);
assert('ICS uses CRLF line endings', ics.indexOf('\r\n')>0, 'no CRLF');
assert('ICS summary includes facilitator', ics.indexOf('SUMMARY:')>=0 && /SUMMARY:.+ - /.test(ics), 'no summary');

// ── P2: calendar view builds ──
schedCalIdx=null;
var cal=schedRenderCalendar(bo3);
assert('calendar renders a grid', cal.indexOf('sch-cal-grid')>=0, 'no grid');
assert('calendar renders day cells', cal.indexOf('sch-cal-cell')>=0, 'no cells');
// month navigation: defaults to the sprint start month, offers prev/next
assert('calendar shows the sprint start month', cal.indexOf('Mar 2026')>=0, 'no month title');
assert('calendar exposes month nav', cal.indexOf('schedCalNav(')>=0, 'no nav');
assert('calendar disables prev at the first month', /schedCalNav\(-1\)"[^>]*disabled/.test(cal), 'prev not disabled');
// single-month sprint (Mar 2026) -> next also disabled; navigating clamps in range
schedCalNav(1);
assert('nav clamps within sprint months', schedCalIdx===schedMonthIdx(_team.cfg.startDate), schedCalIdx);
// multi-month sprint -> next enabled and navigation reaches the later month
var savedEnd=_team.cfg.endDate;
_team.cfg.endDate='2026-04-10';
schedCalIdx=null;
var calMM=schedRenderCalendar(schedBuild());
assert('multi-month sprint enables next', !/schedCalNav\(1\)"[^>]*disabled/.test(calMM), 'next disabled');
schedCalNav(1);
var calApr=schedRenderCalendar(schedBuild());
assert('navigating forward reveals the next month', calApr.indexOf('Apr 2026')>=0, 'no Apr');
assert('nav clamps at the last month', (schedCalNav(1), schedCalIdx===schedMonthIdx('2026-04-10')), schedCalIdx);
_team.cfg.endDate=savedEnd; schedCalIdx=null;

// ── By-ceremony columns view ──
var cc=schedRenderCeremonyCols(bo3);
assert('ceremony view renders a columns grid', cc.indexOf('sch-cer-grid')>=0, 'no grid');
var nCols=(cc.match(/sch-cer-col-hd/g)||[]).length;
var nCers=_team.sched.ceremonies.filter(function(c){return c.enabled;}).length;
assert('ceremony view has one column per enabled ceremony', nCols===nCers, nCols+' vs '+nCers);
assert('ceremony view has per-ceremony Slack copy', cc.indexOf('schedCopyCeremony(')>=0, 'no copy btn');

// ── Per-ceremony eligibility ──
_team.sched.overrides={};
_team.members[1].exclude=['retro'];        // Bob opts out of retro
var be=schedBuild();
assert('excluded member never leads that ceremony', (be.counts.retro['Bob']||0)===0, be.counts.retro['Bob']);
assert('excluded member still leads others', (be.counts.standup['Bob']||0)>0, be.counts.standup['Bob']);
assert('schedEligible false for excluded', schedEligible(_team.members[1],'retro')===false, 'elig');
assert('schedEligible true otherwise', schedEligible(_team.members[1],'standup')===true, 'elig');
// exclude everyone from retro -> needs cover
_team.members.forEach(function(m){ m.exclude=['retro']; });
var be2=schedBuild();
var retroRow=be2.rows.filter(function(r){return r.key==='retro';})[0];
assert('all-excluded ceremony needs cover', retroRow.assigned===null, retroRow.assigned);
_team.members.forEach(function(m){ delete m.exclude; });

// ── Shared PTO dates (Planner PTO drives Scheduler availability) ──
_team.members.forEach(function(m){ delete m.leave; delete m.ptoDates; });
_team.members[0].ptoDates=['2026-03-02','2026-03-03','2026-03-07','2026-04-01']; // Mon,Tue in-sprint; Sat; out-of-range
assert('mbrPtoCount counts in-sprint working days only', mbrPtoCount(_team.members[0])===2, mbrPtoCount(_team.members[0]));
_team.members[1].pto=3;
assert('mbrPtoCount falls back to legacy typed count', mbrPtoCount(_team.members[1])===3, mbrPtoCount(_team.members[1]));
holidays=[{date:'2026-03-03',name:'H'}];
assert('mbrPtoCount excludes company holidays', mbrPtoCount(_team.members[0])===1, mbrPtoCount(_team.members[0]));
holidays=[];
assert('schedAvail false on a PTO date', schedAvail(_team.members[0],'2026-03-02')===false, 'avail');
assert('schedAvail true off PTO', schedAvail(_team.members[0],'2026-03-04')===true, 'avail');
_team.members[0].ptoDates=['2026-03-02']; _team.members[1].pto=0;
var bp=schedBuild();
var mp2=bp.rows.filter(function(r){return r.date==='2026-03-02'&&r.key==='standup';})[0];
assert('PTO-driven reassignment away from Alice', mp2.assigned!=='Alice', mp2.assigned);
assert('PTO-driven cover badge for Alice', mp2.coverFor==='Alice', mp2.coverFor);
// half-day PTO
_team.members[0].ptoDates=['2026-03-02']; _team.members[0].ptoHalf=['2026-03-03'];
assert('half day counts as 0.5 (1 full + 1 half = 1.5)', mbrPtoCount(_team.members[0])===1.5, mbrPtoCount(_team.members[0]));
assert('full-day PTO -> unavailable', schedAvail(_team.members[0],'2026-03-02')===false, 'full avail');
assert('half-day PTO -> still available', schedAvail(_team.members[0],'2026-03-03')===true, 'half avail');
_team.members.forEach(function(m){ delete m.ptoDates; delete m.ptoHalf; delete m.pto; });

// ── Scheduler-only people (roster beyond the planner) ──
_team.sched.ceremonies.find(function(c){return c.key==='retro';}).enabled=true;
_team.sched.extraPeople=[{name:'Zoe',ptoDates:[],exclude:[]}];
assert('roster includes scheduler-only person', schedRoster().some(function(p){return p.name==='Zoe';}), 'missing');
assert('roster = members + extra', schedRoster().length===_team.members.length+1, schedRoster().length);
var br=schedBuild();
assert('extra person gets standup leads', (br.counts.standup['Zoe']||0)>0, br.counts.standup['Zoe']);
_team.sched.extraPeople=[{name:'Zoe',ptoDates:['2026-03-02'],exclude:[]}];
assert('extra person leave is respected', schedAvail(schedExtra()[0],'2026-03-02')===false, 'avail');
_team.sched.extraPeople=[{name:'Zoe',ptoDates:[],exclude:['retro']}];
var br2=schedBuild();
assert('extra person eligibility opt-out works', (br2.counts.retro['Zoe']||0)===0, br2.counts.retro['Zoe']);
_team.sched.extraPeople=[];

LOG('');
LOG('=== '+pass+' passed, '+fail+' failed ===');
OUT;
