import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('bingotools.html', 'utf8');
const room = src.match(/<!-- ROOM_V2_START -->[\s\S]*?<!-- ROOM_V2_END -->/);
if (!room) throw new Error('ROOM_V2 missing');
const timer = src.match(/<div class="timer-box timer-box-stopwatch">[\s\S]*?<\/div>\s*<\/div>\s*(?=\s*<!-- 红方计分 -->)/);
const toolbar = src.match(/<div class="btns-toolbar[^"]*" id="btnsToolbar">[\s\S]*?<\/div>\s*(?=\s*<div class="cell-notes-preamble-bar)/);

// V18 是独立网页派生物。旧仓库可能没有预置 V18，此时从已生成的 V17
// 继续生成，避免同步脚本因为缺少一个派生文件而中断整个发布流程。
let v18;
try {
  v18 = readFileSync('index/bingotools-V18.html', 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  v18 = readFileSync('index/bingotools-V17.html', 'utf8');
}
if (timer) {
  v18 = v18.replace(/<div class="timer-box timer-box-stopwatch">[\s\S]*?<\/div>\s*<\/div>\s*(?=\s*<!-- 红方计分 -->)/, timer[0]);
}
if (toolbar) {
  v18 = v18.replace(/<div class="btns-toolbar[^"]*" id="btnsToolbar">[\s\S]*?<\/div>\s*(?=\s*<div class="cell-notes-preamble-bar)/, toolbar[0]);
}
if (!v18.includes('.btns-toolbar.bt-has-room-row')) {
  v18 = v18.replace(
    '.btns-toolbar {\n  flex-shrink: 0;\n  width: 100%;\n}\n.bingo-table-wrap.btns-collapsed .btns-toolbar {\n  display: none;\n}',
    `.btns-toolbar {
  flex-shrink: 0;
  width: 100%;
}
.btns-toolbar.bt-has-room-row {
  max-height: none;
  height: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bt-room-btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
}
.bingo-table-wrap.btns-collapsed .btns-toolbar {
  display: none;
}`
  );
}
if (!v18.includes('.timer-box-stopwatch .match-status')) {
  v18 = v18.replace(
    '.timer-box-countdown,\n.timer-box-stopwatch {\n  flex: 1 1 0;\n  min-height: 0;\n}',
    `.timer-box-countdown,
.timer-box-stopwatch {
  flex: 1 1 0;
  min-height: 0;
}
.timer-box-stopwatch .match-status,
.timer-box-stopwatch #matchSyncStatus {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.35;
  text-align: center;
  color: #ccc;
  margin-top: 4px;
  max-height: 2.8em;
  overflow: auto;
}
.timer-box-stopwatch #endLocalOnlyBtn {
  margin-top: 4px;
  align-self: center;
}`
  );
}
if (v18.includes('<!-- ROOM_V2_START -->')) {
  v18 = v18.replace(/<!-- ROOM_V2_START -->[\s\S]*?<!-- ROOM_V2_END -->/, () => room[0]);
} else {
  v18 = v18.replace('</body>', room[0] + '\n</body>');
}
writeFileSync('index/bingotools-V18.html', v18);
console.log({
  timer: !!timer,
  toolbar: !!toolbar,
  beginInTimer: /timer-box-stopwatch[\s\S]*?id="beginMatchBtn"/.test(src),
  listOnlyRow: /id="roomListBtn"/.test(src) && !/id="btRoomBtnRow"/.test(src) && !/id="roomMiniBtn"/.test(src),
  roomModalHead: src.includes('room-modal-head'),
  roomDetailSide: src.includes('roomDetailArea')
});
