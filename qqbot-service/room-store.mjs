// PostgreSQL persistence for v2 room state. The domain layer keeps its
// validation and CAS rules; this store makes each accepted snapshot durable.
export class RoomStore {
  constructor(pool) {
    this.pool = pool;
    this.tail = Promise.resolve();
  }

  async load() {
    const pending = await this.pool.query(
      "UPDATE bingotools_room_notifications SET status = 'unknown', error = '服务重启前发送结果未确认' WHERE status = 'pending'"
    );
    void pending;
    const [sessions, rooms, members, notifications, roster, settings, idempotency] = await Promise.all([
      this.pool.query('SELECT * FROM bingotools_sessions'),
      this.pool.query('SELECT * FROM bingotools_rooms ORDER BY updated_at'),
      this.pool.query('SELECT * FROM bingotools_room_members'),
      this.pool.query('SELECT * FROM bingotools_room_notifications'),
      this.pool.query('SELECT * FROM bingotools_roster'),
      this.pool.query('SELECT * FROM bingotools_settings WHERE id = 1'),
      this.pool.query('SELECT * FROM bingotools_idempotency')
    ]);
    const memberMap = new Map();
    for (const row of members.rows) {
      if (!memberMap.has(row.room_id)) memberMap.set(row.room_id, []);
      memberMap.get(row.room_id).push({ id: row.member_id, name: row.name, seen: Number(row.seen_at_ms) });
    }
    const deliveryMap = new Map();
    for (const row of notifications.rows) {
      if (!deliveryMap.has(row.room_id)) deliveryMap.set(row.room_id, {});
      deliveryMap.get(row.room_id)[row.kind] = { status: row.status, error: row.error || '' };
    }
    const roomsData = new Map();
    const remountByRequest = new Map();
    for (const row of rooms.rows) {
      const room = {
        id: row.id, host: row.host_session_id, match: row.match, board: row.board, scores: row.scores,
        state: row.state, rev: Number(row.revision), elapsed: Number(row.elapsed_seconds),
        anchor: Number(row.running_since_ms || 0), startedAt: Number(row.started_at_ms || 0),
        countdown: Number(row.countdown_seconds || 0), countdownEnd: Number(row.countdown_end_ms || 0),
        createdAt: Number(row.created_at_ms), updatedAt: Number(row.updated_at_ms),
        members: memberMap.get(row.id) || [], delivery: deliveryMap.get(row.id) || {},
        records: row.records || [], remounts: row.remounts || {}
      };
      roomsData.set(room.id, room);
      for (const [requestId, roomId] of Object.entries(room.remounts)) remountByRequest.set(requestId, roomId);
    }
    const sessionMap = new Map();
    for (const row of sessions.rows) {
      sessionMap.set(row.token_hash, {
        id: row.stable_id, devUntil: Number(row.dev_until_ms || 0), expires: Number(row.expires_at_ms), creates: new Map()
      });
    }
    for (const row of idempotency.rows) {
      const session = sessionMap.get(row.session_hash);
      if (!session) continue;
      if (row.action === 'create') session.creates.set(row.request_id, { id: row.room_id, fingerprint: row.fingerprint });
    }
    const rosterMap = new Map();
    for (const row of roster.rows) rosterMap.set(row.roster_key, {
      name: row.name, platform: row.platform, source: row.source, room: row.room, updatedAt: Number(row.updated_at_ms)
    });
    return {
      sessions: sessionMap,
      rooms: roomsData,
      roster: rosterMap,
      settings: settings.rows[0] ? { enabled: settings.rows[0].enabled, interval: Number(settings.rows[0].interval_minutes) } : { enabled: false, interval: 5 },
      remountByRequest
    };
  }

  save(snapshot) {
    const operation = this.tail.then(() => this.#save(snapshot));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async #save(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE bingotools_room_members, bingotools_room_notifications, bingotools_idempotency, bingotools_rooms, bingotools_sessions, bingotools_roster, bingotools_settings');
      for (const [hash, session] of snapshot.sessions) {
        await client.query(
          'INSERT INTO bingotools_sessions (token_hash, stable_id, expires_at_ms, dev_until_ms) VALUES ($1,$2,$3,$4)',
          [hash, session.id, session.expires, session.devUntil]
        );
        for (const [requestId, item] of session.creates || []) {
          await client.query(
            'INSERT INTO bingotools_idempotency (session_hash, action, request_id, fingerprint, room_id) VALUES ($1,$2,$3,$4,$5)',
            [hash, 'create', requestId, item.fingerprint, item.id]
          );
        }
      }
      for (const room of snapshot.rooms.values()) {
        await client.query(`INSERT INTO bingotools_rooms
          (id, host_session_id, state, revision, match, board, scores, elapsed_seconds, running_since_ms,
           started_at_ms, countdown_seconds, countdown_end_ms, created_at_ms, updated_at_ms, records, remounts)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)`, [
          room.id, room.host, room.state, room.rev, JSON.stringify(room.match), JSON.stringify(room.board), JSON.stringify(room.scores),
          room.elapsed, room.anchor || null, room.startedAt || null, room.countdown, room.countdownEnd || null,
          room.createdAt, room.updatedAt, JSON.stringify(room.records || []), JSON.stringify(room.remounts || {})
        ]);
        for (const member of room.members || []) await client.query(
          'INSERT INTO bingotools_room_members (room_id, member_id, name, seen_at_ms) VALUES ($1,$2,$3,$4)',
          [room.id, member.id, member.name, member.seen]
        );
        for (const [kind, delivery] of Object.entries(room.delivery || {})) await client.query(
          'INSERT INTO bingotools_room_notifications (room_id, kind, status, error) VALUES ($1,$2,$3,$4)',
          [room.id, kind, delivery.status, delivery.error || '']
        );
      }
      for (const [key, entry] of snapshot.roster) await client.query(
        'INSERT INTO bingotools_roster (roster_key, name, platform, source, room, updated_at_ms) VALUES ($1,$2,$3,$4,$5,$6)',
        [key, entry.name, entry.platform, entry.source, entry.room, entry.updatedAt]
      );
      await client.query('INSERT INTO bingotools_settings (id, enabled, interval_minutes) VALUES (1,$1,$2)', [snapshot.settings.enabled, snapshot.settings.interval]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
