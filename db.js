/* ============================================================
   Golf Tracker — shared IndexedDB data layer
   Loaded by every page. Exposes `GolfDB` on window.
   ============================================================ */

const GolfDB = (() => {
  const DB_NAME = 'golf-tracker';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;

        if (!db.objectStoreNames.contains('players')) {
          const store = db.createObjectStore('players', { keyPath: 'id', autoIncrement: true });
          store.createIndex('name', 'name', { unique: false });
        }

        if (!db.objectStoreNames.contains('courses')) {
          db.createObjectStore('courses', { keyPath: 'id', autoIncrement: true });
        }

        if (!db.objectStoreNames.contains('rounds')) {
          const store = db.createObjectStore('rounds', { keyPath: 'id', autoIncrement: true });
          store.createIndex('date', 'date', { unique: false });
          store.createIndex('courseId', 'courseId', { unique: false });
        }

        // scores: one record per (roundId, playerId, holeNumber)
        if (!db.objectStoreNames.contains('scores')) {
          const store = db.createObjectStore('scores', { keyPath: 'id', autoIncrement: true });
          store.createIndex('roundId', 'roundId', { unique: false });
          store.createIndex('roundPlayer', ['roundId', 'playerId'], { unique: false });
        }
      };

      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode = 'readonly') {
    const db = await open();
    return db.transaction(storeNames, mode);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------- generic helpers ----------

  async function add(storeName, value) {
    const t = await tx([storeName], 'readwrite');
    const store = t.objectStore(storeName);
    const id = await reqToPromise(store.add(value));
    return id;
  }

  async function put(storeName, value) {
    const t = await tx([storeName], 'readwrite');
    const store = t.objectStore(storeName);
    const id = await reqToPromise(store.put(value));
    return id;
  }

  async function getAll(storeName) {
    const t = await tx([storeName], 'readonly');
    const store = t.objectStore(storeName);
    return reqToPromise(store.getAll());
  }

  async function get(storeName, id) {
    const t = await tx([storeName], 'readonly');
    const store = t.objectStore(storeName);
    return reqToPromise(store.get(id));
  }

  async function remove(storeName, id) {
    const t = await tx([storeName], 'readwrite');
    const store = t.objectStore(storeName);
    await reqToPromise(store.delete(id));
  }

  async function getByIndex(storeName, indexName, value) {
    const t = await tx([storeName], 'readonly');
    const store = t.objectStore(storeName);
    const idx = store.index(indexName);
    return reqToPromise(idx.getAll(value));
  }

  // ---------- domain-specific ----------

  async function createCourse(course) {
    // course = { name, holes: [{number, par}, ...] }
    return add('courses', course);
  }

  async function updateCourse(course) {
    return put('courses', course);
  }

  async function createPlayer(name) {
    return add('players', { name });
  }

  async function createRound({ date, courseId, playerIds }) {
    const roundId = await add('rounds', { date, courseId, playerIds });
    return roundId;
  }

  async function setScore(roundId, playerId, holeNumber, strokes) {
    // find existing score record for this round/player/hole
    const t = await tx(['scores'], 'readwrite');
    const store = t.objectStore('scores');
    const idx = store.index('roundPlayer');
    const existing = await reqToPromise(idx.getAll([roundId, playerId]));
    const match = existing.find(s => s.holeNumber === holeNumber);
    if (match) {
      match.strokes = strokes;
      await reqToPromise(store.put(match));
      return match.id;
    } else {
      const id = await reqToPromise(store.add({ roundId, playerId, holeNumber, strokes, penalties: 0 }));
      return id;
    }
  }

  async function setPenalty(roundId, playerId, holeNumber, penalties) {
    const t = await tx(['scores'], 'readwrite');
    const store = t.objectStore('scores');
    const idx = store.index('roundPlayer');
    const existing = await reqToPromise(idx.getAll([roundId, playerId]));
    const match = existing.find(s => s.holeNumber === holeNumber);
    if (match) {
      match.penalties = penalties;
      await reqToPromise(store.put(match));
      return match.id;
    } else {
      const id = await reqToPromise(store.add({ roundId, playerId, holeNumber, strokes: 0, penalties }));
      return id;
    }
  }

  async function getScoresForRound(roundId) {
    return getByIndex('scores', 'roundId', roundId);
  }

  async function getScoresForPlayer(playerId) {
    const all = await getAll('scores');
    return all.filter(s => s.playerId === playerId);
  }

  async function deleteRoundCascade(roundId) {
    const scores = await getScoresForRound(roundId);
    const t = await tx(['scores', 'rounds'], 'readwrite');
    const scoreStore = t.objectStore('scores');
    const roundStore = t.objectStore('rounds');
    for (const s of scores) {
      await reqToPromise(scoreStore.delete(s.id));
    }
    await reqToPromise(roundStore.delete(roundId));
  }

  // ---------- export / import ----------

  async function exportAll() {
    const [players, courses, rounds, scores] = await Promise.all([
      getAll('players'), getAll('courses'), getAll('rounds'), getAll('scores')
    ]);
    return {
      exportedAt: new Date().toISOString(),
      version: DB_VERSION,
      players, courses, rounds, scores
    };
  }

  async function importAll(data, mode = 'merge') {
    // mode: 'merge' keeps existing + adds new with fresh IDs remapped;
    // 'replace' wipes everything first.
    const db = await open();

    if (mode === 'replace') {
      const t = db.transaction(['players', 'courses', 'rounds', 'scores'], 'readwrite');
      t.objectStore('players').clear();
      t.objectStore('courses').clear();
      t.objectStore('rounds').clear();
      t.objectStore('scores').clear();
      await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    }

    // Remap old IDs -> new IDs to avoid collisions
    const playerIdMap = {};
    const courseIdMap = {};
    const roundIdMap = {};

    for (const p of (data.players || [])) {
      const oldId = p.id;
      const copy = { ...p };
      delete copy.id;
      const newId = await add('players', copy);
      playerIdMap[oldId] = newId;
    }

    for (const c of (data.courses || [])) {
      const oldId = c.id;
      const copy = { ...c };
      delete copy.id;
      const newId = await add('courses', copy);
      courseIdMap[oldId] = newId;
    }

    for (const r of (data.rounds || [])) {
      const oldId = r.id;
      const copy = { ...r };
      delete copy.id;
      copy.courseId = courseIdMap[r.courseId] ?? r.courseId;
      copy.playerIds = (r.playerIds || []).map(pid => playerIdMap[pid] ?? pid);
      const newId = await add('rounds', copy);
      roundIdMap[oldId] = newId;
    }

    for (const s of (data.scores || [])) {
      const copy = { ...s };
      delete copy.id;
      copy.roundId = roundIdMap[s.roundId] ?? s.roundId;
      copy.playerId = playerIdMap[s.playerId] ?? s.playerId;
      await add('scores', copy);
    }

    return { playerIdMap, courseIdMap, roundIdMap };
  }

  return {
    open,
    add, put, getAll, get, remove, getByIndex,
    createCourse, updateCourse,
    createPlayer,
    createRound,
    setScore, setPenalty, getScoresForRound, getScoresForPlayer, deleteRoundCascade,
    exportAll, importAll
  };
})();
