import test from 'node:test';
import assert from 'node:assert/strict';
import { Matches } from './matches.mjs';
const payload = { started_at: '2026-09-18T12:00:00Z', referee: {room:'123',title:'裁判直播'}, left:{name:'甲'},right:{name:'乙'},scores:{red:3,blue:5} };
function setup(send = async () => {}) {
 return new Matches({pool:()=>null,requireDatabase:()=>false,send,normalize:b=>structuredClone(b),formatStart:()=> '开始',address:(_,r)=>'https://live.bilibili.com/'+r,cleanError:String});
}
test('start and end are idempotent; stale score cannot overwrite final score; only active matches returned', async()=>{
 const sent=[]; const m=setup(async text=>sent.push(text));
 const result=await Promise.all([m.start('match-12345',payload),m.start('match-12345',payload)]);
 assert.equal(result[0].ok,true); assert.equal(sent.length,1);
 await m.start('match-67890',payload);
 await m.update({match_id:'match-12345',revision:2,scores:{red:8,blue:12}});
 await m.update({match_id:'match-12345',revision:1,scores:{red:0,blue:0}});
 assert.match(await m.current(),/甲：8 分/);
 const end={match_id:'match-12345',revision:3,scores:{red:9,blue:13}};
 await Promise.all([m.update(end,true),m.update(end,true)]);
 assert.equal(sent.length,3); assert.match(sent[2],/最终得分/); assert.match(sent[2],/蓝方 乙：13 分/);
 await assert.rejects(m.update({...end,revision:4}),/已结束/);
 assert.doesNotMatch(await m.current(),/甲：9 分/);
 assert.match(await m.current(),/甲：3 分/);
});
test('uncertain delivery never repeats automatically or appears as a confirmed active match',async()=>{
 let sends=0;const m=setup(async()=>{sends++;throw Object.assign(new Error('timeout'),{uncertain:true});});
 assert.equal((await m.start('match-12345',payload)).uncertain,true);
 await assert.rejects(m.start('match-12345',payload),/不会自动重复/);
 assert.equal(sends,1);assert.equal(await m.current(),'目前没有正在进行的比赛。');
});
test('missing database fails closed and malformed scores never send',async()=>{
 const m=setup(()=>{throw new Error('should not send');});m.requireDatabase=()=>true;
 await assert.rejects(m.start('match-12345',payload),/数据库未就绪/);
 await assert.rejects(m.start('match-12345',{...payload,scores:{red:'3',blue:2}}),/比分无效/);
});
test('a definite rejection can retry with the same final scores',async()=>{
 let reject=true;
 const m=setup(async()=>{if(reject) throw new Error('rate limited');});
 assert.equal((await m.start('match-retry',payload)).ok,false);
 reject=false;
 assert.equal((await m.start('match-retry',payload)).ok,true);
 const end={match_id:'match-retry',revision:1,scores:{red:10,blue:20}};
 reject=true;
 assert.equal((await m.update(end,true)).ok,false);
 reject=false;
 assert.equal((await m.update(end,true)).ok,true);
 assert.equal(await m.current(),'目前没有正在进行的比赛。');
});
