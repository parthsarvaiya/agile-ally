// ── Scheduler test harness: stubs so scheduler.js runs headless ──
var OUT=''; function LOG(s){ OUT+=s+'\n'; }
function esc(s){ return String(s==null?'':s); }
function showToast(){}
function dSave(){}
var holidays=[];
var _team={
  name:'Test Team',
  cfg:{startDate:'2026-03-02', endDate:'2026-03-13'},   // Mon..Fri over 2 weeks = 10 working days
  members:[
    {name:'Alice',role:'Dev'},
    {name:'Bob',role:'Dev'},
    {name:'Carol',role:'QA'},
    {name:'Dan',role:'Dev'}
  ]
};
function at(){ return _team; }
function q(){ return null; }
