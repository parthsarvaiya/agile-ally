// ── E2E test harness: stubs so analytics.js runs headless in JXA ──
var OUT='';
function LOG(s){ OUT += s + '\n'; }
var _team={id:'t1',name:'Test',sprints:[
  {name:'Sprint 40',committed:42,pts:38,notes:''},
  {name:'Sprint 41',committed:40,pts:44,notes:''}
],members:[]};
function at(){return _team;}
function q(){return null;}            // no DOM: render fns bail early
function esc(s){return String(s==null?'':s);}
function showToast(){}
function setTimeout(){return 0;}      // JXA lacks these
function clearTimeout(){}
var document={addEventListener:function(){}};
var localStorage={_s:{},getItem:function(k){return this._s[k]||null;},setItem:function(k,v){this._s[k]=v;},removeItem:function(k){delete this._s[k];}};
var window={};
function parseCSV(text){
  return text.trim().split(/\r?\n/).map(function(line){
    var f=[],cur='',inQ=false;
    for(var i=0;i<line.length;i++){var c=line[i];
      if(c==='"'){ if(inQ&&line[i+1]==='"'){cur+='"';i++;} else inQ=!inQ; }
      else if(c===','&&!inQ){f.push(cur.trim());cur='';} else cur+=c; }
    f.push(cur.trim()); return f;
  });
}
