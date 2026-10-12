import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const client = read('frontend/room/client.js').replace('  // BOARD_ADAPTER', read('frontend/room/board.js'));
let html = read('bingotools.html');

// Keep the base page changes needed by the room module reproducible in CI.
// The transformations are idempotent so release jobs can run them again after
// the generated HTML has already been committed.
if (html.includes('function getParticipantPayload(side) {')) {
  html = html.replace(
    'function getParticipantPayload(side) {',
    'function getParticipantPayload(side, options = {}) {'
  ).replace(
    "  const nameFromForm = nameInput ? String(nameInput.value || '').trim() : '';",
    "  const preferForm = options.preferForm !== false;\n  const nameFromForm = preferForm && nameInput ? String(nameInput.value || '').trim() : '';"
  );
}
if (!html.includes('function getCurrentParticipantPayload(side) {')) {
  html = html.replace(
    /(\nfunction getParticipantPayload\(side, options = \{\}\) \{[\s\S]*?\n\}\n)(\nfunction buildMatchStartPayload)/,
    "$1\nfunction getCurrentParticipantPayload(side) {\n  return getParticipantPayload(side, { preferForm: false });\n}\n$2"
  );
}
if (!html.includes('syncLiveRoomIdsFromSources();\n  if (window.BingoRooms?.syncCurrentState)')) {
  html = html.replace(
    /(function setLiveSource\(side, source\) \{[\s\S]*?  syncLiveRoomIdsFromSources\(\);)(\n\})/,
    '$1\n  if (window.BingoRooms?.syncCurrentState) window.BingoRooms.syncCurrentState();$2'
  );
}
if (!html.includes('updateTeamNames();\n  if (window.BingoRooms?.syncCurrentState)')) {
  html = html.replace(
    /(function applyStreamerNameToTeam\(num, name\) \{[\s\S]*?  updateTeamNames\(\);)(\n\})/,
    '$1\n  if (window.BingoRooms?.syncCurrentState) window.BingoRooms.syncCurrentState();$2'
  );
}

const block = `<!-- ROOM_V2_START -->\n<script>\n${client}\n</script>\n<!-- ROOM_V2_END -->`;
if (html.includes('<!-- ROOM_V2_START -->')) html = html.replace(/<!-- ROOM_V2_START -->[\s\S]*?<!-- ROOM_V2_END -->/, () => block);
else html = html.replace('</body>', block + '\n</body>');
writeFileSync(new URL('bingotools.html', root), html);
writeFileSync(new URL('frontend/dist/index.html', root), html);
