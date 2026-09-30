import { readFileSync, writeFileSync } from 'node:fs';

// V17/V18 独立页面均从当前桌面源码生成，避免只替换房间模块而遗留旧设置和权限提示。
const standalone = readFileSync('index/bingotools-V17.html', 'utf8');
if (!standalone.includes('<!-- ROOM_V2_START -->')) throw new Error('ROOM_V2 missing');
writeFileSync('index/bingotools-V18.html', standalone);
console.log('已同步 index/bingotools-V18.html');
