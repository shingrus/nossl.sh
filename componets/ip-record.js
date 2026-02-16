export const createIpRecordService = (db, { maxRecords: maxRecordsOverride } = {}) => {
  if (!db) {
    throw new Error('Database instance is required to create the IP record service');
  }

  const PRUNE_CHECK_RATE = 0.1;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ip_records
    (
        ip TEXT NOT NULL,
        endpoint TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (ip, endpoint)
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_records_ip_endpoint
    ON ip_records (ip, endpoint)
  `);

  const envConfiguredMax = Number.parseInt(
    process.env.MAX_IP_RECORDS  ?? '',
    10,
  );
  const defaultMaxRecords =
    Number.isFinite(envConfiguredMax) && envConfiguredMax > 0 ? envConfiguredMax : 100000;
  const maxRecords =
    Number.isFinite(maxRecordsOverride) && maxRecordsOverride > 0
      ? maxRecordsOverride
      : defaultMaxRecords;
  const pruneThreshold = Math.max(maxRecords, Math.ceil(maxRecords * 1.2));

  const upsertIpRecordStmt = db.prepare(`
    INSERT INTO ip_records (endpoint, ip, hits, last_seen)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(ip, endpoint) DO UPDATE SET
        hits = ip_records.hits + 1,
        last_seen = excluded.last_seen
  `);
  const countRecordsByEndpointStmt = db.prepare(
    'SELECT COUNT(*) AS total FROM ip_records WHERE endpoint = ?',
  );
  const pruneEndpointRecordsStmt = db.prepare(`
    DELETE FROM ip_records
    WHERE endpoint = ?
      AND ip IN (
        SELECT ip
        FROM ip_records
        WHERE endpoint = ?
        ORDER BY last_seen
        LIMIT ?
      )
  `);

  const recordIp = db.transaction((endpoint, ip, timestamp) => {
    upsertIpRecordStmt.run(endpoint, ip, timestamp);
    if (Math.random() >= PRUNE_CHECK_RATE) {
      return;
    }
    const { total } = countRecordsByEndpointStmt.get(endpoint);
    if (total > pruneThreshold) {
      const toRemove = total - maxRecords;
      if (toRemove > 0) {
        pruneEndpointRecordsStmt.run(endpoint, endpoint, toRemove);
      }
    }
  });

  const addIpRecord = (endpoint, ip) => {
    const normalizedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
    const normalizedIp = typeof ip === 'string' ? ip.trim() : '';
    if (!normalizedEndpoint || !normalizedIp) {
      return;
    }
    recordIp(normalizedEndpoint, normalizedIp, new Date().toISOString());
  };

  return {
    addIpRecord,
    maxRecords,
  };
};
