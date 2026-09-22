const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const {resolve} = require('node:path');
const root = resolve(__dirname, '..');
Object.assign(process.env,{RENDER:'true',QQ_APP_ID:'mock',QQ_APP_SECRET:'mock',QQ_GROUP_OPENID:'mock',BOT_CLIENT_KEY:'mock',QQ_EVENTS_ENABLED:'false',ALLOWED_ORIGINS:'null',BINGOTOOLS_DEV_CODE:'test-dev'});
(async()=>{
 global.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('getAppAccessToken')?{access_token:'mock',expires_in:7200}:{id:'mock-message'}));
 const {createServer}=await import(pathToFileURL(resolve(root, 'qqbot-service/server.mjs')).href);
 const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
 try {
 const errors=[];
 async function page(){const context=await browser.newContext({viewport:{width:1600,height:1100}});await context.addInitScript(url=>localStorage.setItem('bingotools_qq_bot_config',JSON.stringify({serviceUrl:url})),base);await context.route('**/*',route=>{const u=route.request().url();return /^(file:|http:\/\/127.0.0.1:)/.test(u)?route.continue():route.abort()});const p=await context.newPage();p.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});p.on('dialog',d=>d.accept(d.type()==='prompt'?(d.message().includes('地址')?'https://live.bilibili.com/456':'观众测试'):undefined));await p.goto(pathToFileURL(resolve(root, 'index/bingotools-V17.html')).href);await p.waitForFunction(()=>document.getElementById('matchSyncStatus').textContent.includes('已连接'));return p;}
 const host=await page(),guest=await page();
 await host.locator('#beginMatchBtn').click();await host.locator('#refereeRoomInput').fill('123');await host.locator('#refereeTitleInput').fill('裁判测试');await host.locator('#saveAndStartMatchBtn').click();
 await host.waitForFunction(()=>window.BingoRooms.getRoom()?.state==='playing');
 const id=await host.evaluate(()=>window.BingoRooms.getRoom().id);
 await guest.locator('#roomListBtn').click();await guest.locator('#roomJoinCode').fill(id);await guest.locator('#roomJoin').click();await guest.waitForFunction(()=>window.BingoRooms.getRoom()?.state==='playing');
 assert.equal(await guest.evaluate(()=>window.BingoRooms.getRoom().canControl),false);
 await host.evaluate(()=>adjustExtra(1,7));
 await guest.waitForFunction(()=>window.BingoRooms.getRoom()?.scores.red===7);
 await guest.evaluate(()=>adjustExtra(1,100));assert.equal(await guest.evaluate(()=>window.BingoRooms.getRoom().scores.red),7);
 await host.locator('#roomListBtn').click();await host.locator('#roomMount').click();await host.waitForFunction(()=>window.BingoRooms.getRoom()?.state==='mounted');await host.locator('#roomClose').click();
 await guest.locator('#roomListBtn').click();await guest.locator('#roomRefresh').click();await guest.locator('[data-op="takeover"][data-room="'+id+'"]').click();
 await guest.waitForFunction(()=>window.BingoRooms.getRoom()?.isHost===true);
 await guest.locator('#endMatchBtn').click();await guest.waitForFunction(()=>window.BingoRooms.getRoom()?.state==='ended');
 assert.equal(await guest.evaluate(()=>BingoRooms.getRoom().scores.red),7);
 await guest.locator('#roomListBtn').click();await guest.locator('[data-op="remount"][data-room="'+id+'"]').click();await guest.waitForTimeout(800);
 assert.ok(await guest.locator('[data-op="takeover"]').count());
 await guest.locator('#roomClose').click();await guest.evaluate(()=>showSetModal());
 await guest.locator('#roomDevCode').fill('test-dev');await guest.locator('#roomDevLogin').click();await guest.locator('#roomDevControls').waitFor({state:'visible'});
 await guest.locator('#roomAutoEnabled').check();await guest.locator('#roomAutoSave').click();
 await host.locator('#roomMiniBtn').click();assert.equal(await host.locator('#roomMini').isVisible(),true);
 console.log('PASS: two clients, scoring, readonly, mount, takeover, end, history, developer settings, mini window');

 assert.deepEqual(errors,[]);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exit(1)});
