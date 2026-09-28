// ── E2E test body: parse sample CSV via real functions, assert ──
var _app=Application.currentApplication(); _app.includeStandardAdditions=true;
var CSV_PATH='/Users/parth.sarvaiya/Downloads/Vibes Project/SPRINT PLANNER/sample-issues.csv';
var pass=0, fail=0;
function assert(name, cond, got){ if(cond){pass++; LOG('PASS  '+name);} else {fail++; LOG('FAIL  '+name+'   (got: '+got+')');} }

LOG('=== Flow analytics end-to-end (headless compute) ===');

// round-trip a known date through the real parser
assert('date parse 2026-03-02', flowToISO(flowParseDate('2026-03-02','auto'))==='2026-03-02', flowToISO(flowParseDate('2026-03-02','auto')));

var csv=_app.read(Path(CSV_PATH));
var rows=parseCSV(csv), headers=rows[0];
var data=rows.slice(1).filter(function(r){return r.some(function(c){return c!=='';});});
function col(rx){ return headers.findIndex(function(h){return rx.test(h);}); }
var ci={id:col(/key|^id$/i),type:col(/type/i),status:col(/status/i),created:col(/created/i),started:col(/start/i),completed:col(/resolved|done|completed/i),points:col(/point/i),sprint:col(/sprint/i)};

var items=data.map(function(r){
  return {id:r[ci.id]||'',type:r[ci.type]||'',status:r[ci.status]||'',statusCategory:r[ci.status]||'',
    created:flowToISO(flowParseDate(r[ci.created],'auto')),
    started:ci.started>=0?flowToISO(flowParseDate(r[ci.started],'auto')):'',
    completed:flowToISO(flowParseDate(r[ci.completed],'auto')),
    points:parseFloat(r[ci.points])||0, sprint:r[ci.sprint]||''};
}).filter(function(i){return i.created||i.completed;});
flowSetItems(items);

assert('parsed 32 items', items.length===32, items.length);
var completed=items.filter(function(i){return i.completed;});
assert('26 completed', completed.length===26, completed.length);
var withStart=items.filter(function(i){return i.started;});
assert('29 with start date', withStart.length===29, withStart.length);

// velocity samples (count + points)
var vs=flowVelocitySamples('count'), vp=flowVelocitySamples('points');
assert('6 throughput samples', vs.samples.length===6, vs.samples.length);
assert('throughput = [5,5,5,4,4,3]', vs.samples.join(',')==='5,5,5,4,4,3', vs.samples.join(','));
assert('points = [23,19,21,18,18,14]', vp.samples.join(',')==='23,19,21,18,18,14', vp.samples.join(','));
LOG('  velocity source: '+vs.source);

// durations
var durs=flowDurations();
var leads=durs.filter(function(d){return d.lead!=null;}).map(function(d){return d.lead;}).sort(function(a,b){return a-b;});
var cycles=durs.filter(function(d){return d.cycle!=null;}).map(function(d){return d.cycle;}).sort(function(a,b){return a-b;});
assert('26 lead times', leads.length===26, leads.length);
assert('all leads > 0', leads.every(function(v){return v>0;}), leads.join(','));
assert('26 cycle times', cycles.length===26, cycles.length);
LOG('  lead sorted: ['+leads.join(',')+']');
LOG('  median lead='+flowPct(leads,50)+'  P85='+flowPct(leads,85)+'  (work days)');
LOG('  median cycle='+flowPct(cycles,50)+'  P85='+flowPct(cycles,85));

// classify + gap
var cls=flowClassify('medianLead', flowPct(leads,50));
assert('medianLead classifies', !!cls, cls);
LOG('  medianLead tier='+(cls&&cls.tier)+'  gap: '+flowGap('medianLead', flowPct(leads,50)));
// classifier boundary checks (medianLead t=[7,14,30], lower better)
assert('classify 6 -> excellent', flowClassify('medianLead',6).tier==='excellent', flowClassify('medianLead',6).tier);
assert('classify 10 -> good', flowClassify('medianLead',10).tier==='good', flowClassify('medianLead',10).tier);
assert('classify 20 -> attention', flowClassify('medianLead',20).tier==='attention', flowClassify('medianLead',20).tier);
assert('classify 40 -> critical', flowClassify('medianLead',40).tier==='critical', flowClassify('medianLead',40).tier);
// higher-better metric (flowEff t=[40,25,15])
assert('flowEff 50 -> excellent', flowClassify('flowEff',50).tier==='excellent', flowClassify('flowEff',50).tier);
assert('flowEff 20 -> attention', flowClassify('flowEff',20).tier==='attention', flowClassify('flowEff',20).tier);

// net flow + defect
var P=flowThroughputPeriods();
var net=P.reduce(function(s,p){return s+(p.completed-p.created);},0);
assert('cumulative net flow = -6', net===-6, net);
var bugs=0,done=0; P.forEach(function(p){bugs+=p.bugs;done+=p.completed;});
assert('7 completed bugs', bugs===7, bugs);
LOG('  defect rate='+Math.round(bugs/done*100)+'%  ('+bugs+'/'+done+')');

// Monte Carlo — deterministic bounds (not exact, seedless)
var totals=flowSimHowMany(vs.samples,6,10000);
var safe=flowPct(totals,15), mid=flowPct(totals,50);
assert('MC howmany monotonic (safe<=mid)', safe<=mid, safe+' / '+mid);
assert('MC howmany plausible (15..30)', mid>=15&&mid<=30, mid);
LOG('  MC how-many 6 sprints: 50%='+mid+'  85% safe='+safe+' items');
var counts=flowSimWhenDone(vp.samples,100,0,10000);
var c50=flowPct(counts,50), c85=flowPct(counts,85);
assert('MC whendone monotonic (c50<=c85)', c50<=c85, c50+' / '+c85);
LOG('  MC when-done 100 pts: 50%='+c50+'  85%='+c85+' sprints');

// CoV / stats
var st=flowStats(vs.samples);
LOG('  throughput CoV='+Math.round(st.cov*100)+'%  (mean '+Math.round(st.mean*10)/10+')');
assert('CoV in [0,1] for stable samples', st.cov>0&&st.cov<1, st.cov);

// benchmark override round-trips
_team.__t=0;
flowStore.settings.bench={medianLead:[3,6,12]};
assert('override applied (lead 5 -> good now)', flowClassify('medianLead',5).tier==='good', flowClassify('medianLead',5).tier);
delete flowStore.settings.bench;
assert('override cleared (lead 5 -> excellent)', flowClassify('medianLead',5).tier==='excellent', flowClassify('medianLead',5).tier);

// ── V3-3: WIP & aging ──
var cfd=flowCfdData();
assert('CFD builds', !!cfd, cfd);
if(cfd){
  var li=cfd.done.length-1;
  assert('CFD final done = 26', cfd.done[li]===26, cfd.done[li]);
  assert('CFD final in-progress = 3', cfd.inp[li]===3, cfd.inp[li]);
  assert('CFD final to-do = 3', cfd.todo[li]===3, cfd.todo[li]);
  assert('CFD bands sum to 32 created', cfd.done[li]+cfd.inp[li]+cfd.todo[li]===32, cfd.done[li]+cfd.inp[li]+cfd.todo[li]);
}
var open=flowOpenItems(), bl=flowBacklogItems();
assert('3 open (in-progress) items', open.length===3, open.length);
assert('3 backlog (to-do) items', bl.length===3, bl.length);
assert('open items sorted by age desc', open.every(function(o,i){return i===0||open[i-1].age>=o.age;}), open.map(function(o){return o.age;}).join(','));
var ll=flowLittlesLaw();
assert('Littles Law returns positive', ll>0, ll);
var z=flowAgeZones();
assert('age zones from cycle pct (p50=5,p85=7)', z.p50===5&&z.p85===7, z.p50+'/'+z.p85);
LOG('  open ages: ['+open.map(function(o){return o.age;}).join(',')+']  backlog ages: ['+bl.map(function(b){return b.age;}).join(',')+']');
LOG('  Littles Law WIP estimate = '+ll);

// ── V3-4: bottleneck, KDE/bimodal, SLE attainment ──
var bn=flowBottleneck(cfd);
assert('bottleneck detects a location', !!(bn&&bn.location), bn&&bn.location);
LOG('  bottleneck: '+(bn&&bn.location));
var kde=flowKde(leads);
assert('KDE builds 48 samples', kde&&kde.xs.length===48, kde&&kde.xs.length);
var pk=flowPeaks(kde);
assert('KDE finds at least one peak', pk.length>=1, pk.length);
assert('sample lead dist is unimodal', pk.length===1, pk.length+' peaks at '+pk.map(function(p){return Math.round(p.x);}).join(','));
LOG('  lead-time peaks at: ['+pk.map(function(p){return Math.round(p.x);}).join(',')+'] '+(pk.length>=2?'(BIMODAL)':'(unimodal)'));
var sleTarget=flowPct(leads,85);
var overallAttain=Math.round(leads.filter(function(v){return v<=sleTarget;}).length/leads.length*100);
assert('SLE attainment >= 85% at P85 target', overallAttain>=85, overallAttain);
LOG('  SLE target='+sleTarget+' days, overall attainment='+overallAttain+'%');

// ── V3-5: health score + recommendations ──
assert('score lower@excellent-boundary =75', flowScore('medianLead',7)===75, flowScore('medianLead',7));
assert('score lower@good-boundary =45', flowScore('medianLead',14)===45, flowScore('medianLead',14));
assert('score lower@0 =100', flowScore('medianLead',0)===100, flowScore('medianLead',0));
assert('score higher@excellent-boundary =75', flowScore('flowEff',40)===75, flowScore('flowEff',40));
assert('score higher@good-boundary =45', flowScore('flowEff',25)===45, flowScore('flowEff',25));
var h=flowHealthScores();
assert('health has 4 sub-scores', h&&h.subs.length===4, h&&h.subs.length);
assert('health overall in 0..100', h&&h.overall>=0&&h.overall<=100, h&&h.overall);
LOG('  health overall='+(h&&h.overall)+'  subs=['+(h?h.subs.map(function(s){return (s.score==null?'-':s.score);}).join(','):'')+']');
var recs=flowRecommendations();
assert('recommendations returned', recs.length>=1, recs.length);
assert('recommendations capped at 5', recs.length<=5, recs.length);
assert('non-positive recs all carry a guardrail', recs.filter(function(r){return r.sev!=='positive';}).every(function(r){return !!r.guard;}), 'ok');
assert('at least one positive signal', recs.some(function(r){return r.sev==='positive';}), recs.map(function(r){return r.sev;}).join(','));
LOG('  recommendations: '+recs.map(function(r){return r.sev+':'+r.cat;}).join(', '));

// ── Trendline overlay ──
var trendChart=flowLineSVG(['a','b','c','d'],[{label:'x',color:'#000',vals:[1,2,3,4]}],{trend:true});
assert('trendline drawn when opts.trend set', trendChart.indexOf('stroke-dasharray="5 4"')>=0, 'no trendline');
assert('trend labelled by type in legend', trendChart.indexOf('trend (linear)')>=0, 'type label missing');
var noTrend=flowLineSVG(['a','b'],[{label:'x',color:'#000',vals:[1,2]}],{});
assert('no trendline without opts.trend', noTrend.indexOf('stroke-dasharray="5 4"')<0, 'unexpected trendline');
// per-chart controls
flowChartCtl={};
var cc=flowLineSVG(['a','b','c','d'],[{label:'x',color:'#000',vals:[1,2,3,4]}],{id:'t1',controls:true,defTrend:'linear'});
assert('control chips render', cc.indexOf('flowSetChartStyle')>=0 && cc.indexOf('flowSetTrend')>=0, 'no controls');
assert('default linear trend applies', cc.indexOf('stroke-dasharray="5 4"')>=0, 'no default trend');
flowChartCtl.t1={style:'bar',labels:true,trend:'none'};
var cb=flowLineSVG(['a','b','c','d'],[{label:'x',color:'#000',vals:[1,2,3,4]}],{id:'t1',controls:true});
assert('bar style renders rect bars', cb.indexOf('<rect')>=0, 'no bars');
assert('trend=none suppresses trendline', cb.indexOf('stroke-dasharray="5 4"')<0, 'unexpected trend');
assert('moving-average fit returns points', (flowTrendLine([1,2,3,4],'ma')||[]).length===4, 'ma');
assert('polynomial fit returns a curve', (flowTrendLine([1,4,9,16,25],'poly')||[]).length>1, 'poly');
assert('exponential fit returns a curve', (flowTrendLine([1,2,4,8],'exp')||[]).length>1, 'exp');
// per-chart export button
var rowWithSvg=flowChartRow({title:'X', chart:'<div class="fa-chart"><svg></svg></div>', benchKey:'medianLead', value:5});
assert('export button on charts with an svg', rowWithSvg.indexOf('fa-export-btn')>=0, 'no export btn');
var rowNoSvg=flowChartRow({title:'Y', chart:'<table></table>', benchKey:'wipAging', value:null});
assert('no export button on table-only charts', rowNoSvg.indexOf('fa-export-btn')<0, 'unexpected export btn');
assert('export btn helper sanitizes title', flowExportBtn("Lead time (avg)").indexOf('Lead time avg')>=0, flowExportBtn("Lead time (avg)"));
flowChartCtl={};
flowToggleLabels('t2'); flowSetTrend('t2','poly'); flowSetChartStyle('t2','bar');
assert('control handlers persist state', flowChartCtl.t2 && flowChartCtl.t2.labels===true && flowChartCtl.t2.trend==='poly' && flowChartCtl.t2.style==='bar', JSON.stringify(flowChartCtl.t2));
flowChartCtl={};

// ── V3-6B: ZIP CRC32 + annotations ──
assert('CRC32("123456789") = 0xCBF43926', flowCrc32([49,50,51,52,53,54,55,56,57])===0xCBF43926, flowCrc32([49,50,51,52,53,54,55,56,57]).toString(16));
if(!flowStore.teams['t1']) flowStore.teams['t1']={};
flowStore.teams['t1'].annotations=[{date:'2026-03-15',label:'TestEvent'}];
assert('annotations getter returns the entry', flowAnnotations().length===1, flowAnnotations().length);
var lp=flowDurations().filter(function(d){return d.lead!=null&&d.completed;}).map(function(d){return {t:+d.completed,y:d.lead,id:d.item.id};});
var scat=flowScatterSVG(lp,'lead','#4F46E5');
assert('scatter overlays annotation label', scat.indexOf('TestEvent')>=0, 'label not rendered');
var scatEarly=flowScatterSVG(lp.filter(function(p){return p.t> (+new Date(2026,3,1));}),'lead','#4F46E5');
assert('annotation hidden when out of range', scatEarly.indexOf('TestEvent')<0, 'shown out of range');
flowStore.teams['t1'].annotations=[];

// ── Sprint comparison (Sprint Insights) ──
var slist=flowSprintList();
assert('sprint list has >=2 sprints', slist.length>=2, slist.length);
assert('sprint list most-recent-first', slist[0]==='Sprint 45'||slist[0]==='Sprint 46', slist.slice(0,3).join(','));
var s40=flowSprintStats('Sprint 40');
assert('Sprint 40 total = 5', s40.total===5, s40.total);
assert('Sprint 40 done = 5', s40.done===5, s40.done);
assert('Sprint 40 done points = 23', s40.donePts===23, s40.donePts);
var s46=flowSprintStats('Sprint 46');
assert('Sprint 46 has open items (done<total)', s46.done<s46.total, s46.done+'/'+s46.total);
assert('completion rate is a percent', s40.rate===100, s40.rate);
assert('Sprint 40 spillover = 0', s40.spillover===0, s40.spillover);
assert('Sprint 40 defect rate = 20%', s40.defectRate===20, s40.defectRate);
assert('Sprint 40 avg item size = 4.6', s40.avgSize===4.6, s40.avgSize);
assert('Sprint 40 P85 lead >= median lead', s40.p85Lead>=s40.medLead, s40.p85Lead+'/'+s40.medLead);
assert('Sprint 40 flow efficiency is a percent', s40.flowEff>0&&s40.flowEff<=100, s40.flowEff);
assert('no assignee -> contributors null', s40.contributors===null, s40.contributors);
var it40=flowItems().filter(function(i){return i.sprint==='Sprint 40'&&i.completed;});
it40.forEach(function(i,k){ i.assignee = k<3?'Alice':'Bob'; });
var ld=flowLoadStats('Sprint 40');
assert('team load contributors = 2', ld.contributors===2, ld.contributors);
assert('team load top share = 60%', ld.topShare===60, ld.topShare);
var s40b=flowSprintStats('Sprint 40');
assert('sprintStats concentration = 60% with assignees', s40b.concentration===60, s40b.concentration);
it40.forEach(function(i){ delete i.assignee; });

// ── V3-6A: sample generator (runs last — replaces items) ──
flowLoadSample();
var samp=flowItems();
assert('sample generator makes 100 items', samp.length===100, samp.length);
assert('sample items all have a created date', samp.every(function(i){return !!i.created;}), 'some missing created');
var sc=samp.filter(function(i){return i.completed;}).length;
assert('sample completed count in 50..90', sc>=50&&sc<=90, sc);
assert('sample ids TEAM-1001..TEAM-1100', samp[0].id==='TEAM-1001'&&samp[99].id==='TEAM-1100', samp[0].id+'..'+samp[99].id);
var sdurs=flowDurations().filter(function(d){return d.lead!=null;});
assert('durations compute for all completed samples', sdurs.length===sc, sdurs.length+' vs '+sc);
assert('sample health score computes', !!flowHealthScores(), flowHealthScores());
assert('sample recommendations compute', flowRecommendations().length>=1, flowRecommendations().length);
LOG('  sample dataset: '+samp.length+' items, '+sc+' completed, health='+flowHealthScores().overall);

LOG('');
LOG('=== '+pass+' passed, '+fail+' failed ===');
OUT;
