  function collectBoard() {
    var board = {
      red: [], blue: [], first: [], marks: [], redTime: [], blueTime: [],
      settle1: 0, settle2: 0, extra1: 0, extra2: 0, settleHistory: [],
      cellTexts: null, redName: '红方', blueName: '蓝方'
    };
    try {
      var i;
      for (i = 0; i < 25; i++) {
        board.red.push(!!red[i]);
        board.blue.push(!!blue[i]);
        board.first.push(first && (first[i] === 'R' || first[i] === 'B') ? first[i] : null);
        board.marks.push(cellMarks && cellMarks[i] ? cellMarks[i].slice() : []);
        board.redTime.push(typeof redTime !== 'undefined' && redTime ? (redTime[i] || 0) : 0);
        board.blueTime.push(typeof blueTime !== 'undefined' && blueTime ? (blueTime[i] || 0) : 0);
      }
      board.settle1 = typeof settle1 !== 'undefined' ? (settle1 || 0) : 0;
      board.settle2 = typeof settle2 !== 'undefined' ? (settle2 || 0) : 0;
      board.extra1 = typeof extra1 !== 'undefined' ? (extra1 || 0) : 0;
      board.extra2 = typeof extra2 !== 'undefined' ? (extra2 || 0) : 0;
      board.settleHistory = (typeof settleHistory !== 'undefined' && settleHistory) ? settleHistory.slice() : [];
      if (typeof settings !== 'undefined' && settings) {
        board.scoring = {};
        for (const key of ['rowScores', 'maxTasksPerLine', 'halfScoreForLate', 'allowLateFill', 'bingoScore', 'bingoScoreRest', 'maxBingoCountRed', 'maxBingoCountBlue', 'maxGlobalSettleCount', 'maxSettleCount', 'settleScorePerTime', 'settleScoreRest']) board.scoring[key] = structuredClone(settings[key]);
        if (settings.cellTexts && settings.cellTexts.length === 25) board.cellTexts = settings.cellTexts.slice();
        if (settings.redTeamName) board.redName = settings.redTeamName;
        if (settings.blueTeamName) board.blueName = settings.blueTeamName;
      }
    } catch (e) {}
    var names = {red: document.getElementById("redName").textContent, blue: document.getElementById("blueName").textContent};
    if (!board.redName) board.redName = names.red;
    if (!board.blueName) board.blueName = names.blue;
    return board;
  }
  function applyBoard(board) {
    if (!board) return;
    session.applying = true;
    try {
      var i;
      for (i = 0; i < 25; i++) {
        try {
          red[i] = !!(board.red && board.red[i]);
          blue[i] = !!(board.blue && board.blue[i]);
          if (typeof first !== 'undefined' && first) first[i] = board.first && (board.first[i] === 'R' || board.first[i] === 'B') ? board.first[i] : null;
          if (typeof cellMarks !== 'undefined' && cellMarks) cellMarks[i] = (board.marks && board.marks[i]) ? board.marks[i].slice() : [];
          if (typeof redTime !== 'undefined' && redTime) redTime[i] = (board.redTime && board.redTime[i]) || 0;
          if (typeof blueTime !== 'undefined' && blueTime) blueTime[i] = (board.blueTime && board.blueTime[i]) || 0;
        } catch (e) {}
      }
      try { settle1 = board.settle1 || 0; } catch (e) {}
      try { settle2 = board.settle2 || 0; } catch (e) {}
      try { extra1 = board.extra1 || 0; } catch (e) {}
      try { extra2 = board.extra2 || 0; } catch (e) {}
      try { settleHistory = (board.settleHistory || []).slice(); } catch (e) {}
      try {
        if (typeof settings !== 'undefined' && settings) {
          for (const key of ['rowScores', 'maxTasksPerLine', 'halfScoreForLate', 'allowLateFill', 'bingoScore', 'bingoScoreRest', 'maxBingoCountRed', 'maxBingoCountBlue', 'maxGlobalSettleCount', 'maxSettleCount', 'settleScorePerTime', 'settleScoreRest']) if (board.scoring?.[key] !== undefined) settings[key] = structuredClone(board.scoring[key]);
          if (board.redName) settings.redTeamName = board.redName;
          if (board.blueName) settings.blueTeamName = board.blueName;
          if (board.cellTexts && board.cellTexts.length === 25) settings.cellTexts = board.cellTexts.slice();
        }
      } catch (e) {}
      try { if (typeof updateTeamNames === 'function') updateTeamNames(); } catch (e) {}
      try { if (typeof render === 'function') render(); } catch (e) {}
      try { if (typeof refreshScore === 'function') refreshScore(); } catch (e) {}
      try { if (typeof saveGameState === 'function') saveGameState(); } catch (e) {}

    } finally {
      session.applying = false;
    }
  }
