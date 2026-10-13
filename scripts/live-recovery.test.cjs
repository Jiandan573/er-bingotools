const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const html = fs.readFileSync('bingotools.html', 'utf8');
function harness(kind = 'hls') {
  let now = 1000, id = 0;
  const timers = new Map(), intervals = new Map(), calls = [], players = [], tips = [];
  const videos = {};
  for (const side of [1, 2]) videos[side] = {
    paused: true, currentTime: 0, events: {}, classList: { add() {}, remove() {} },
    pause() { this.paused = true; }, load() {}, removeAttribute() {},
    play() { this.paused = false; return Promise.resolve(); }, canPlayType() { return true; },
    addEventListener(n, fn) { (this.events[n] ||= new Set()).add(fn); },
    removeEventListener(n, fn) { this.events[n]?.delete(fn); },
    emit(n) { for (const fn of this.events[n] || []) fn(); }
  };
  class Player {
    constructor() { this.events = {}; this.destroyed = 0; players.push(this); }
    on(n, f) { this.events[n] = f; }
    emit(n, d) { this.events[n]?.(n, d); }
    destroy() { this.destroyed++; }
    attachMedia() {} loadSource() {} attachMediaElement() {} load() {} play() { return Promise.resolve(); }
  }
  const ctx = vm.createContext({ console: {warn() {}, error() {}}, Promise,
    Date: {now: () => now},
    setTimeout: (fn, ms) => {timers.set(++id, {fn, ms}); return id;}, clearTimeout: n => timers.delete(n),
    setInterval: fn => { intervals.set(++id, fn); return id;}, clearInterval: n => intervals.delete(n),
    document: {getElementById: n => videos[n.replace('liveVideo', '')] || null},
    window: {go: {app: {App: {ResolveLive: async (...args) => {calls.push(args); return {kind};}}}}},
    Hls: Object.assign(Player, {isSupported: () => true, Events: {ERROR: 'hls-error', MANIFEST_PARSED: 'manifest'}}),
    flvjs: {isSupported: () => true, Events: {ERROR: 'flv-error'}, createPlayer: () => new Player()},
    liveStreamPlayers: {1: null, 2: null}, liveStreamKinds: {1: '', 2: ''},
    stopLiveIframe() {}, loadBilibiliEmbed(side) {vm.runInContext(`stopNetworkStream(${side})`, ctx);},
    setLiveTip: (...a) => tips.push(a), applyLiveCropToMain() {}, applyLiveMute() {}, syncLiveOverlayForSide() {}
  });
  vm.runInContext(html.slice(html.indexOf('function isGoBound()'), html.indexOf('// ---------- P4 网络流播放工具结束')), ctx);
  const run = code => vm.runInContext(code, ctx);
  return {ctx, run, timers, intervals, players, calls, videos, tips,
    start: side => run(`loadStream(${side}, {type:'bilibili', value:'${side}'})`),
    async retry() {const [n, t] = timers.entries().next().value; timers.delete(n); t.fn(); await flush(); return t.ms;},
    tick(ms) {now += ms; for (const fn of [...intervals.values()]) fn();}
  };
}
async function flush() {for (let n = 0; n < 12; n++) await Promise.resolve();}
test('frontend scripts compile and desktop asset is synchronized', () => {
  assert.equal(html, fs.readFileSync('frontend/dist/index.html', 'utf8'));
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
});
test('HLS fatal errors deduplicate, re-resolve and exhaust finite exponential budget', async () => {
  const h = harness(); await h.start(1);
  for (const delay of [2000, 4000, 8000, 16000, 30000]) {
    const p = h.players.at(-1); p.emit('hls-error', {fatal:true}); p.emit('hls-error', {fatal:true});
    assert.equal(h.timers.size, 1); assert.equal(p.destroyed, 1);
    assert.equal(await h.retry(), delay);
  }
  h.players.at(-1).emit('hls-error', {fatal:true});
  assert.equal(h.calls.length, 6); assert.equal(h.timers.size, 0);
  assert.match(h.tips.at(-1)[1], /自动恢复失败/);
  await h.start(1); assert.equal(h.calls.length, 7);
});
test('nonfatal HLS errors do not rebuild; FLV and native video errors recover', async () => {
  const h = harness(); await h.start(1); h.players[0].emit('hls-error', {fatal:false}); assert.equal(h.timers.size, 0);
  const f = harness('flv'); await f.start(1); f.players[0].emit('flv-error'); assert.equal(await f.retry(), 2000);
  const n = harness('hls'); n.ctx.Hls.isSupported = () => false; await n.start(1);
  n.videos[1].emit('error'); assert.equal(await n.retry(), 2000);
});
test('sides are independent; stop/local/embed cancels pending retries and callbacks', async () => {
  const h = harness(); await Promise.all([h.start(1), h.start(2)]);
  const old = h.players[0]; old.emit('hls-error', {fatal:true});
  assert.equal(h.players[1].destroyed, 0);
  await h.run("loadStream(1, {type:'local'})"); assert.equal(h.timers.size, 0);
  old.emit('hls-error', {fatal:true}); assert.equal(h.timers.size, 0);
  await h.start(1); await h.run("loadStream(1, {type:'bilibili', value:'1', playMode:'embed'})");
  assert.equal(h.run('liveRecovery[1]'), null);
});
test('stalls/startup timeouts recover, deliberate pause does not; stable playback resets budget', async () => {
  const h = harness(); await h.start(1); h.tick(30000); assert.equal(h.timers.size, 1);
  await h.retry(); const v = h.videos[1]; v.paused = false; v.currentTime++; h.tick(3000);
  v.paused = true; h.tick(60000); assert.equal(h.timers.size, 0);
  v.paused = false;
  for (let i=0; i<22; i++) {v.currentTime++; h.tick(3000);}
  assert.equal(h.run('liveRecovery[1].attempts'), 0);
  h.tick(30000); assert.equal(h.timers.size, 1);
});
test('ResolveLive failures retry; overlapping refreshes serialize and stale results cannot create players', async () => {
  const h = harness(); let release;
  h.ctx.window.go.app.App.ResolveLive = (...a) => {h.calls.push(a); return new Promise(r => release = r);};
  const first = h.start(1); await flush();
  const second = h.start(1); await flush(); assert.equal(h.calls.length, 1);
  release({kind:'hls'}); await flush(); assert.equal(h.calls.length, 2); assert.equal(h.players.length, 0);
  release({kind:'hls'}); await Promise.all([first, second]); assert.equal(h.players.length, 1);
  h.ctx.window.go.app.App.ResolveLive = async () => {throw Error('offline');};
  await h.start(2); assert.equal(h.timers.size, 1); assert.equal(await h.retry(), 2000);
  assert.equal(h.timers.size, 1);
});
