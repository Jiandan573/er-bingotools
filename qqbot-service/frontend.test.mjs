import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index/bingotools-V17.html', import.meta.url), 'utf8');
test('standalone HTML scripts compile and match controls follow stopwatch', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.ok(html.indexOf('id="beginMatchBtn"') > html.indexOf('id="stopwatch-display"'));
  assert.doesNotMatch(html, /onclick="testQQBotConnection/);
  const timer = html.slice(html.indexOf('<div class="timer-box timer-box-stopwatch">'), html.indexOf('<!-- 红方计分 -->'));
  assert.equal((timer.match(/class="timer-box/g) || []).length, 1);
  assert.doesNotMatch(timer, /onclick="(?:start|pause|reset)Stopwatch/);
});

test('local file page sends authenticated API request and omits participant titles', async () => {
  const calls=[];
  const els={
    redName:{innerText:'选手甲'},blueName:{innerText:'选手乙'},
  };
  const ctx=vm.createContext({
    window:{location:{protocol:'file:',origin:'null'}},
    getQQBotConfig:()=>({serviceUrl:'https://bot.example',clientKey:'test-key'}),
    AbortController,setTimeout,clearTimeout,JSON,Error,TypeError,
    fetch:async (url,opts)=>{calls.push({url,opts});return {ok:true,text:async()=>'{"ok":true}'};},
    document:{getElementById:id=>els[id]},
    liveSources:{1:{type:'bilibili',value:'1'},2:{type:'douyin',value:'2'}},
    normalizeLiveSource:s=>s,
  });
  vm.runInContext(html.slice(html.indexOf('async function callQQBot('),html.indexOf('function loadRefereeInfo()')),ctx);
  await vm.runInContext("callQQBot('/api/v1/matches/score',{scores:{red:1,blue:2}})",ctx);
  assert.equal(calls[0].opts.headers.Authorization,'Bearer test-key');
  vm.runInContext(html.slice(html.indexOf('function getParticipantPayload('),html.indexOf('function buildMatchStartPayload(')),ctx);
  const red=vm.runInContext('getParticipantPayload(1)',ctx);
  assert.equal(red.name,'选手甲');assert.equal(red.title,'');
  assert.doesNotMatch(html,/redLiveTitleInput|blueLiveTitleInput|裁判直播间标题/);
  assert.match(html,/for="refereeTitleInput">裁判<\/label>/);
  const nativeCalls=[];
  ctx.window.go={app:{App:{CallQQBot:async (...args)=>{nativeCalls.push(args);return {status:200,body:'{"ok":true}'};}}}};
  await vm.runInContext("callQQBot('/api/v1/matches/end',{scores:{red:1,blue:2}})",ctx);
  assert.equal(calls.length,1);
  assert.equal(nativeCalls[0][2],'/api/v1/matches/end');
});

test('desktop source includes native live playback and has no standalone lock',()=>{
  const desktop=readFileSync(new URL('../frontend/dist/index.html',import.meta.url),'utf8');
  assert.equal(desktop,readFileSync(new URL('../bingotools.html',import.meta.url),'utf8'));
  assert.match(desktop,/<script src="hls.min.js"><\/script>/);
  assert.match(desktop,/<script src="flv.min.js"><\/script>/);
  assert.match(desktop,/window\.go\.app\.App\.ResolveLive/);
  assert.doesNotMatch(desktop,/standaloneLockTip|standalone-locked/);
});

test('HTML reads displayed totals, syncs without announcing, and locks final score after a failed end', async () => {
  const els = new Map();
  const calls = [];
  const store = new Map();
  const ctx = vm.createContext({
    Date, JSON, Number, Boolean, Math,
    activeMatch: null, matchStartedAt: '', pendingMatchPayload: null,
    scoreSyncBusy: false, endingMatch: false, stopwatchSeconds: 0, stopwatchRunning: false,
    stopwatchInterval: null, MATCH_STATE_KEY: 'match',
    localStorage: { getItem: k => store.get(k), setItem: (k,v) => store.set(k,v) },
    document: {getElementById: id => {
      if (!els.has(id)) els.set(id, {innerText:'0',textContent:'',classList:{toggle(){}}});
      return els.get(id);
    }},
    clearInterval(){}, setInterval(){}, showToast(){}, updateStopwatchDisplay(){},
    startStopwatch(){ ctx.stopwatchRunning = true; },
    pauseStopwatch(){ ctx.stopwatchRunning = false; },
    confirm:()=>true,
    callQQBot:async (path,body)=>{calls.push({path,body:structuredClone(body)});},
  });
  const start = html.indexOf('function saveActiveMatch()');
  const end = html.indexOf('function getParticipantPayload', start);
  vm.runInContext(html.slice(start,end),ctx);
  vm.runInContext("setMatchStarted(new Date().toISOString(),'match-test-123')",ctx);
  assert.equal(ctx.stopwatchRunning,true);
  ctx.document.getElementById('t1').innerText='17';
  ctx.document.getElementById('t2').innerText='-2';
  await vm.runInContext('syncMatchScore()',ctx);
  assert.deepEqual(calls[0],{path:'/api/v1/matches/score',body:{match_id:'match-test-123',revision:1,scores:{red:17,blue:-2},elapsed_seconds:0}});
  ctx.stopwatchSeconds=3661;
  ctx.callQQBot = async (path,body) => {
    calls.push({path,body:structuredClone(body)});
    throw new Error('temporary failure');
  };
  await vm.runInContext('endCurrentMatch()',ctx);
  assert.equal(ctx.stopwatchRunning,false);
  ctx.document.getElementById('t1').innerText='99';
  ctx.callQQBot=async (path,body)=>calls.push({path,body:structuredClone(body)});
  await vm.runInContext('endCurrentMatch()',ctx);
  assert.deepEqual(calls[2].body.scores,{red:17,blue:-2});
  assert.equal(calls[2].body.elapsed_seconds,3661);
  assert.equal(ctx.document.getElementById('matchStatus').textContent,'比赛已结束');
  await vm.runInContext('syncMatchScore()',ctx);
  assert.equal(calls.length,3);
});
