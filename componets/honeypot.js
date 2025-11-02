import crypto from 'crypto';

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const randomAlphaNumeric = (length) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return result;
};

const randomPrivateIp = () => {
  const octet = () => crypto.randomInt(1, 255);
  return `10.${octet()}.${octet()}.${octet()}`;
};

export const generateFakeEnvFile = () => {
  const base64Key = crypto.randomBytes(32).toString('base64');
  const dbPassword = randomAlphaNumeric(16);
  const redisHost = randomPrivateIp();
  const redisPassword = randomAlphaNumeric(12);
  const mailFragmentA = randomAlphaNumeric(22);
  const mailFragmentB = `${randomAlphaNumeric(16)}-${randomAlphaNumeric(7)}`;
  const stripePublic = `pk_live_${randomAlphaNumeric(24)}`;
  const stripeSecret = `sk_live_${randomAlphaNumeric(32)}`;
  const sentryKey = randomHex(20);
  const sentryProject = crypto.randomInt(100000, 999999).toString();
  const internalApiHost = randomAlphaNumeric(9).toLowerCase();
  const awsAccessKey = `AKIA${randomAlphaNumeric(16).toUpperCase()}`;
  const awsSecret = randomAlphaNumeric(40);

  return [
    '# Application',
    'APP_NAME=AcmePortal',
    'APP_ENV=production',
    `APP_KEY=base64:${base64Key}`,
    'APP_DEBUG=false',
    'APP_URL=https://app.acme.internal',
    'APP_TIMEZONE=UTC',
    'LOG_CHANNEL=stack',
    'LOG_LEVEL=info',
    '',
    '# Database',
    'DB_CONNECTION=mysql',
    `DB_HOST=${randomPrivateIp()}`,
    'DB_PORT=3306',
    'DB_DATABASE=acme_prod',
    'DB_USERNAME=acme_app',
    `DB_PASSWORD=${dbPassword}`,
    'MYSQL_ATTR_SSL_CA=/etc/ssl/certs/ca-certificates.crt',
    '',
    '# Cache / Session / Queue',
    'CACHE_DRIVER=redis',
    'SESSION_DRIVER=redis',
    'SESSION_LIFETIME=120',
    'QUEUE_CONNECTION=redis',
    '',
    '# Redis',
    `REDIS_HOST=${redisHost}`,
    `REDIS_PASSWORD=${redisPassword}`,
    'REDIS_PORT=6379',
    '',
    '# Mail',
    'MAIL_MAILER=smtp',
    'MAIL_HOST=smtp.nossl.sh',
    'MAIL_PORT=587',
    'MAIL_USERNAME=apikey',
    `MAIL_PASSWORD=SG.${mailFragmentA}.${mailFragmentB}`,
    'MAIL_ENCRYPTION=tls',
    'MAIL_FROM_ADDRESS=noreply@acme.example',
    'MAIL_FROM_NAME="Acme Portal"',
    '',
    '# AWS S3',
    'FILESYSTEM_DRIVER=s3',
    `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
    `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
    'AWS_DEFAULT_REGION=eu-west-1',
    'AWS_BUCKET=acme-prod-eu1',
    '',
    '# Payments',
    `STRIPE_KEY=${stripePublic}`,
    `STRIPE_SECRET=${stripeSecret}`,
    '',
    '# Monitoring / Error reporting',
    `SENTRY_DSN=https://${sentryKey}@o12345.ingest.sentry.io/${sentryProject}`,
    '',
    '# Misc internal services',
    `INTERNAL_API_URL=http://${internalApiHost}.nossl.sh:80`,
    'FEATURE_FLAGS=payments,ab_tests,geoip',
  ].join('\n');
};

export const createHoneypotService = (db, { getClientIp, maxRecords: maxRecordsOverride } = {}) => {
  if (!db) {
    throw new Error('Database instance is required to create the honeypot service');
  }

  if (typeof getClientIp !== 'function') {
    throw new Error('getClientIp function is required to create the honeypot service');
  }

  const envConfiguredMax = Number.parseInt(process.env.MAX_HONEYPOT ?? '', 10);
  const defaultMaxRecords =
    Number.isFinite(envConfiguredMax) && envConfiguredMax > 0 ? envConfiguredMax : 1024;
  const maxRecords =
    Number.isFinite(maxRecordsOverride) && maxRecordsOverride > 0
      ? maxRecordsOverride
      : defaultMaxRecords;
  const pruneThreshold = Math.max(maxRecords, Math.ceil(maxRecords * 1.2));

  const upsertHoneypotStmt = db.prepare(`
    INSERT INTO honeypot_ips (ip, hits, last_seen)
    VALUES (?, 1, ?)
    ON CONFLICT(ip) DO UPDATE SET
        hits = honeypot_ips.hits + 1,
        last_seen = excluded.last_seen
  `);
  const countHoneypotStmt = db.prepare('SELECT COUNT(*) AS total FROM honeypot_ips');
  const pruneHoneypotStmt = db.prepare(`
    DELETE FROM honeypot_ips
    WHERE ip IN (
        SELECT ip
        FROM honeypot_ips
        ORDER BY last_seen
        LIMIT ?
    )
  `);
  const honeypotTotalsStmt = db.prepare(`
    SELECT COUNT(*) AS totalIps,
           COALESCE(SUM(hits), 0) AS totalHits
    FROM honeypot_ips
  `);
  const selectTopHoneypotStmt = db.prepare(`
    SELECT ip, hits, last_seen
    FROM honeypot_ips
    ORDER BY hits DESC, last_seen DESC
    LIMIT ?
  `);

  const recordHoneypotHit = db.transaction((ip, timestamp) => {
    upsertHoneypotStmt.run(ip, timestamp);
    const { total } = countHoneypotStmt.get();
    if (total > pruneThreshold) {
      const toRemove = total - maxRecords;
      if (toRemove > 0) {
        pruneHoneypotStmt.run(toRemove);
      }
    }
  });

  const addHoneypotHit = (ip) => {
    const timestamp = new Date().toISOString();
    recordHoneypotHit(ip, timestamp);
  };

  const getSummary = () => {
    const totals = honeypotTotalsStmt.get();
    const counts = selectTopHoneypotStmt.all(maxRecords).map(({ ip, hits, last_seen: lastSeen }) => ({
      ip,
      hits,
      lastSeen,
    }));
    return {
      totalHits: Number(totals.totalHits ?? 0),
      uniqueIpCount: Number(totals.totalIps ?? 0),
      counts,
    };
  };

  const handleEnvRequest = (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.type('text/plain');
    try {
      const clientIp = getClientIp(req) || 'unknown';
      addHoneypotHit(clientIp);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to record honeypot hit', error);
    }

    const payload = `${generateFakeEnvFile()}\n`;
    if (req.method === 'HEAD') {
      res.set('Content-Length', Buffer.byteLength(payload));
      res.status(200).end();
      return;
    }
    res.send(payload);
  };

  return {
    addHoneypotHit,
    getSummary,
    handleEnvRequest,
    maxRecords,
  };
};
