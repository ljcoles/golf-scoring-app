/* ============================================================
   Golf Tracker — shared stats calculations
   ============================================================ */

// total strokes+penalties for a player on a given round, using only scores
// that have actually been entered (strokes > 0 counts as "played")
function computeRoundTotalsForPlayers(round, course, scores) {
  const totalHoles = course.holes.length;
  return round.playerIds.map(pid => {
    const playerScores = scores.filter(s => s.playerId === pid && s.strokes > 0);
    const holesPlayed = playerScores.length;
    const strokesTotal = playerScores.reduce((s, sc) => s + sc.strokes, 0);
    const penaltiesTotal = playerScores.reduce((s, sc) => s + (sc.penalties || 0), 0);
    const puttsTotal = playerScores.reduce((s, sc) => s + (sc.putts || 0), 0);
    const total = strokesTotal + penaltiesTotal + puttsTotal;
    return { pid, strokesTotal, penaltiesTotal, puttsTotal, total, holesPlayed, complete: holesPlayed === totalHoles };
  });
}

// Per-hole grid for scorecard display: for each hole, each player's strokes
// (raw stroke count only, for the classic scorecard grid — penalties/putts
// shown separately in the totals section)
function computeHoleGrid(round, course, scores) {
  const scoreMap = new Map(); // "holeNumber_playerId" -> strokes
  scores.forEach(s => {
    if (s.strokes > 0) scoreMap.set(`${s.holeNumber}_${s.playerId}`, s.strokes);
  });
  return course.holes.map(h => ({
    number: h.number,
    par: h.par,
    scores: round.playerIds.map(pid => ({
      pid,
      strokes: scoreMap.get(`${h.number}_${pid}`) || null
    }))
  }));
}

// Detailed round summary per player: strokes/penalties/putts/total/toPar,
// plus front-9 and back-9 subtotals (front-9 = holes 1-9 by position, not hole number,
// so 9-hole courses just get one "front" section and no back-9)
function computeRoundSummary(round, course, scores) {
  const frontHoles = course.holes.slice(0, 9);
  const backHoles = course.holes.slice(9);

  function sumFor(pid, holesSubset) {
    const nums = new Set(holesSubset.map(h => h.number));
    const playerScores = scores.filter(s => s.playerId === pid && s.strokes > 0 && nums.has(s.holeNumber));
    const strokes = playerScores.reduce((s, sc) => s + sc.strokes, 0);
    const penalties = playerScores.reduce((s, sc) => s + (sc.penalties || 0), 0);
    const putts = playerScores.reduce((s, sc) => s + (sc.putts || 0), 0);
    const par = holesSubset.reduce((s, h) => s + h.par, 0);
    const holesPlayed = playerScores.length;
    const total = strokes + penalties + putts;
    return { strokes, penalties, putts, total, par, holesPlayed, toPar: total - par };
  }

  const rows = round.playerIds.map(pid => {
    const front = sumFor(pid, frontHoles);
    const back = backHoles.length > 0 ? sumFor(pid, backHoles) : null;
    const all = sumFor(pid, course.holes);
    return { pid, front, back, all };
  });

  return { rows, hasBack: backHoles.length > 0, coursePar: course.holes.reduce((s, h) => s + h.par, 0) };
}

// Build overall + per-course stats for one player across all rounds/courses
async function computePlayerStats(playerId) {
  const [rounds, courses, allScoresForPlayer] = await Promise.all([
    GolfDB.getAll('rounds'),
    GolfDB.getAll('courses'),
    GolfDB.getScoresForPlayer(playerId)
  ]);
  const courseMap = Object.fromEntries(courses.map(c => [c.id, c]));
  const scoresByRound = {};
  allScoresForPlayer.forEach(s => {
    if (!scoresByRound[s.roundId]) scoresByRound[s.roundId] = [];
    scoresByRound[s.roundId].push(s);
  });

  const overall = { roundsPlayed: 0, wins: 0, toParSum: 0, toParCount: 0, best: null, worst: null, totalPenalties: 0, totalPutts: 0, puttsHoleCount: 0 };
  const byCourse = {}; // courseId -> { name, roundsPlayed, toParSum, toParCount, best, worst }

  const relevantRounds = rounds.filter(r => r.playerIds.includes(playerId));

  for (const round of relevantRounds) {
    const course = courseMap[round.courseId];
    if (!course) continue;
    const scores = scoresByRound[round.id] || [];
    const playerScores = scores.filter(s => s.strokes > 0);
    const holesPlayed = playerScores.length;
    if (holesPlayed === 0) continue;

    const strokesTotal = playerScores.reduce((s, sc) => s + sc.strokes, 0);
    const penaltiesTotal = playerScores.reduce((s, sc) => s + (sc.penalties || 0), 0);
    const puttsTotal = playerScores.reduce((s, sc) => s + (sc.putts || 0), 0);
    const puttsHoles = playerScores.filter(sc => (sc.putts || 0) > 0).length;
    const total = strokesTotal + penaltiesTotal + puttsTotal;
    const complete = holesPlayed === course.holes.length;
    const coursePar = course.holes.reduce((s, h) => s + h.par, 0);

    overall.roundsPlayed += 1;
    overall.totalPenalties += penaltiesTotal;
    overall.totalPutts += puttsTotal;
    overall.puttsHoleCount += puttsHoles;

    if (complete) {
      const toPar = total - coursePar;
      overall.toParSum += toPar;
      overall.toParCount += 1;
      if (overall.best == null || total < overall.best.total) overall.best = { total, toPar, date: round.date, courseName: course.name };
      if (overall.worst == null || total > overall.worst.total) overall.worst = { total, toPar, date: round.date, courseName: course.name };

      if (!byCourse[course.id]) byCourse[course.id] = { id: course.id, name: course.name, roundsPlayed: 0, toParSum: 0, toParCount: 0, best: null, worst: null };
      const cs = byCourse[course.id];
      cs.roundsPlayed += 1;
      cs.toParSum += toPar;
      cs.toParCount += 1;
      if (cs.best == null || total < cs.best) cs.best = total;
      if (cs.worst == null || total > cs.worst) cs.worst = total;

      // win check: compare against all players in that round
      const allRoundScores = await GolfDB.getScoresForRound(round.id);
      const allTotals = computeRoundTotalsForPlayers(round, course, allRoundScores);
      const completedTotals = allTotals.filter(t => t.complete);
      if (completedTotals.length > 1) {
        const bestTotal = Math.min(...completedTotals.map(t => t.total));
        const winners = completedTotals.filter(t => t.total === bestTotal).map(t => t.pid);
        if (bestTotal === total && winners.includes(playerId)) {
          overall.wins += 1;
        }
      }
    } else {
      if (!byCourse[course.id]) byCourse[course.id] = { id: course.id, name: course.name, roundsPlayed: 0, toParSum: 0, toParCount: 0, best: null, worst: null };
      byCourse[course.id].roundsPlayed += 1;
    }
  }

  const avgToPar = overall.toParCount > 0 ? overall.toParSum / overall.toParCount : null;
  const avgPuttsPerHole = overall.puttsHoleCount > 0 ? overall.totalPutts / overall.puttsHoleCount : null;
  const courseRows = Object.values(byCourse).map(c => ({
    ...c,
    avgToPar: c.toParCount > 0 ? c.toParSum / c.toParCount : null
  })).sort((a, b) => a.name.localeCompare(b.name));

  return { overall: { ...overall, avgToPar, avgPuttsPerHole }, byCourse: courseRows };
}

// Per-hole stats for one player on one course: lowest/highest/avg strokes,
// avg score-to-par, avg penalty shots, avg putts
async function computePlayerCourseHoleStats(playerId, courseId) {
  const course = await GolfDB.get('courses', courseId);
  if (!course) return null;
  const rounds = (await GolfDB.getAll('rounds')).filter(r => r.courseId === courseId && r.playerIds.includes(playerId));

  const perHole = {}; // holeNumber -> [{strokes, penalties, putts}, ...]
  course.holes.forEach(h => perHole[h.number] = []);

  for (const round of rounds) {
    const scores = await GolfDB.getScoresForRound(round.id);
    scores
      .filter(s => s.playerId === playerId && s.strokes > 0)
      .forEach(s => {
        if (perHole[s.holeNumber]) {
          perHole[s.holeNumber].push({ strokes: s.strokes, penalties: s.penalties || 0, putts: s.putts || 0 });
        }
      });
  }

  const rows = course.holes.map(h => {
    const list = perHole[h.number];
    if (list.length === 0) {
      return { number: h.number, par: h.par, lowest: null, highest: null, avgToPar: null, avgPenalties: null, avgPutts: null, rounds: 0 };
    }
    const strokesList = list.map(l => l.strokes);
    const lowest = Math.min(...strokesList);
    const highest = Math.max(...strokesList);
    const avgStrokes = strokesList.reduce((a, b) => a + b, 0) / strokesList.length;
    const avgToPar = avgStrokes - h.par;
    const avgPenalties = list.reduce((a, l) => a + l.penalties, 0) / list.length;
    const avgPutts = list.reduce((a, l) => a + l.putts, 0) / list.length;
    return { number: h.number, par: h.par, lowest, highest, avgToPar, avgPenalties, avgPutts, rounds: list.length };
  });

  return { course, rows };
}

// Per-hole stroke stats for a course, optionally filtered to one player
async function computeCourseHoleStats(courseId, playerId = null) {
  const course = await GolfDB.get('courses', courseId);
  if (!course) return null;
  const rounds = (await GolfDB.getAll('rounds')).filter(r => r.courseId === courseId);

  const perHole = {}; // holeNumber -> { scores: [strokes,...] }
  course.holes.forEach(h => perHole[h.number] = []);

  for (const round of rounds) {
    const scores = await GolfDB.getScoresForRound(round.id);
    const filtered = playerId ? scores.filter(s => s.playerId === playerId) : scores;
    filtered.forEach(s => {
      if (s.strokes > 0 && perHole[s.holeNumber]) {
        perHole[s.holeNumber].push(s.strokes);
      }
    });
  }

  const rows = course.holes.map(h => {
    const list = perHole[h.number];
    if (list.length === 0) {
      return { number: h.number, par: h.par, lowest: null, highest: null, avg: null, rounds: 0 };
    }
    const lowest = Math.min(...list);
    const highest = Math.max(...list);
    const avg = list.reduce((a, b) => a + b, 0) / list.length;
    return { number: h.number, par: h.par, lowest, highest, avg, rounds: list.length };
  });

  return { course, rows };
}
