import crypto from 'crypto';
import {setNoCacheHeaders} from './cache-headers.js';

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');
const randomItem = (values) => values[crypto.randomInt(0, values.length)];

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

const randomPublicIp = () => {
  const octet = () => crypto.randomInt(1, 255);
  let firstOctet = crypto.randomInt(11, 224);
  if (firstOctet === 127) {
    firstOctet = 126;
  }
  return `${firstOctet}.${octet()}.${octet()}.${octet()}`;
};

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const randomDateInPast = (maxDaysAgo) => {
  const maxSeconds = Math.max(1, maxDaysAgo) * 24 * 60 * 60;
  const offset = crypto.randomInt(1, maxSeconds + 1);
  return new Date(Date.now() - offset * 1000);
};

const formatPhpDateTime = (date) => {
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (num) => String(num).padStart(2, '0');
  return `${month[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
};

const renderInfoRows = (rows) =>
  rows
    .map(([label, value]) => `<tr><td class="e">${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`)
    .join('\n');

const renderDirectiveRows = (rows) =>
  rows
    .map(
      ([directive, localValue, masterValue]) =>
        `<tr><td class="e">${escapeHtml(directive)}</td><td class="v">${escapeHtml(localValue)}</td><td class="v">${escapeHtml(masterValue)}</td></tr>`,
    )
    .join('\n');

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
    'APP_URL=http://app.acme.internal',
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

export const generateFakeAdminConfigFile = () => {
  const dbPassword = randomAlphaNumeric(20);
  const dbReadonlyPassword = randomAlphaNumeric(18);
  const jwtSecret = randomHex(32);
  const appSalt = randomHex(16);
  const redisPassword = randomAlphaNumeric(16);
  const smtpPassword = randomAlphaNumeric(24);
  const hostSuffix = randomAlphaNumeric(6).toLowerCase();

  return [
    '<?php',
    '/*',
    ' * Admin panel runtime config',
    ' * Keep this file outside public web root.',
    ' */',
    "define('APP_ENV', 'production');",
    "define('APP_DEBUG', false);",
    "define('APP_TIMEZONE', 'UTC');",
    "define('APP_SALT', '" + appSalt + "');",
    '',
    '$CONFIG = [',
    "  'db' => [",
    "    'driver' => 'mysqli',",
    `    'host' => '${randomPrivateIp()}',`,
    "    'port' => 3306,",
    "    'database' => 'admin_portal',",
    "    'username' => 'portal_admin',",
    `    'password' => '${dbPassword}',`,
    "    'readonly_user' => 'portal_ro',",
    `    'readonly_password' => '${dbReadonlyPassword}',`,
    '  ],',
    "  'redis' => [",
    `    'host' => '${randomPrivateIp()}',`,
    "    'port' => 6379,",
    `    'password' => '${redisPassword}',`,
    '  ],',
    "  'session' => [",
    "    'cookie_name' => 'ADMINSESSID',",
    '    \'secure\' => false,',
    "    'lifetime' => 7200,",
    '  ],',
    "  'mail' => [",
    `    'host' => 'smtp-${hostSuffix}.nossl.sh',`,
    "    'port' => 587,",
    "    'username' => 'alerts@nossl.sh',",
    `    'password' => '${smtpPassword}',`,
    '  ],',
    `  'jwt_secret' => '${jwtSecret}',`,
    "  'allowed_admin_cidr' => ['10.0.0.0/8', '192.168.0.0/16'],",
    '];',
    '',
    '$GLOBALS[\'admin_config\'] = $CONFIG;',
    '',
    '?>',
  ].join('\n');
};

export const generateFakePhpInfoPage = (req, {clientIp: providedClientIp} = {}) => {
  const phpVersions = ['8.1.32', '8.2.28', '8.3.17'];
  const phpVersion = randomItem(phpVersions);
  const [major, minor] = phpVersion.split('.');
  const phpSeries = `${major}.${minor}`;

  const sapiProfiles = [
    {
      serverApi: 'Apache 2.0 Handler',
      serverSoftware: 'Apache/2.4.58 (Ubuntu) OpenSSL/3.0.13',
      phpIniPath: `/etc/php/${phpSeries}/apache2/php.ini`,
      iniScanDir: `/etc/php/${phpSeries}/apache2/conf.d`,
      serverPort: '80',
      threadSafety: 'disabled',
    },
    {
      serverApi: 'FPM/FastCGI',
      serverSoftware: 'nginx/1.24.0',
      phpIniPath: `/etc/php/${phpSeries}/fpm/php.ini`,
      iniScanDir: `/etc/php/${phpSeries}/fpm/conf.d`,
      serverPort: '443',
      threadSafety: 'disabled',
    },
    {
      serverApi: 'CGI/FastCGI',
      serverSoftware: 'Apache/2.4.57 (Debian) OpenSSL/3.0.11',
      phpIniPath: `/etc/php/${phpSeries}/cgi/php.ini`,
      iniScanDir: `/etc/php/${phpSeries}/cgi/conf.d`,
      serverPort: '80',
      threadSafety: 'enabled',
    },
  ];
  const profile = randomItem(sapiProfiles);
  const phpApiBySeries = {
    '8.1': '20210902',
    '8.2': '20220829',
    '8.3': '20230831',
  };
  const zendVersionBySeries = {
    '8.1': `4.1.${phpVersion.split('.')[2]}`,
    '8.2': `4.2.${phpVersion.split('.')[2]}`,
    '8.3': `4.3.${phpVersion.split('.')[2]}`,
  };

  const requestUri = typeof req?.originalUrl === 'string' && req.originalUrl.trim()
    ? req.originalUrl
    : '/phpinfo.php';
  const queryIndex = requestUri.indexOf('?');
  const queryString = queryIndex === -1 ? '' : requestUri.slice(queryIndex + 1);
  const method = typeof req?.method === 'string' ? req.method : 'GET';

  const rawHost = typeof req?.headers?.host === 'string' ? req.headers.host : '';
  const normalizedHost = rawHost.replaceAll(/[\r\n\t]/g, '').trim();
  const host = normalizedHost || `${randomAlphaNumeric(10).toLowerCase()}.nossl.sh`;
  const [serverName, requestedPort] = host.split(':');
  const serverPort = requestedPort || profile.serverPort;

  const rawUserAgent = typeof req?.headers?.['user-agent'] === 'string'
    ? req.headers['user-agent']
    : randomItem([
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'curl/8.7.1',
        'Wget/1.21.4',
      ]);
  const userAgent = rawUserAgent.slice(0, 240);
  const remoteAddr = providedClientIp || randomPublicIp();
  const localAddr = randomPrivateIp();
  const uniqueId = randomAlphaNumeric(27);
  const buildDate = formatPhpDateTime(randomDateInPast(120));
  const startupDate = Math.floor(randomDateInPast(20).getTime() / 1000);
  const systemKernel = `${crypto.randomInt(5, 7)}.${crypto.randomInt(0, 20)}.${crypto.randomInt(0, 30)}-${crypto.randomInt(1000, 1100)}-aws`;
  const systemHost = `ip-${localAddr.replaceAll('.', '-')}.ec2.internal`;
  const extensionApi = phpApiBySeries[phpSeries] || '20230831';
  const zendVersion = zendVersionBySeries[phpSeries] || '4.3.17';
  const maxExecutionTime = String(randomItem([30, 60, 120]));
  const maxInputTime = String(randomItem([60, 120]));
  const memoryLimit = randomItem(['128M', '256M', '512M']);
  const postMaxSize = randomItem(['8M', '16M', '32M']);
  const uploadMaxFilesize = randomItem(['2M', '8M', '16M']);
  const maxInputVars = String(randomItem([1000, 2000, 4000]));
  const sessionSavePath = '/var/lib/php/sessions';
  const tempDir = randomItem(['/tmp', '/var/tmp']);
  const timezone = randomItem(['UTC', 'Etc/UTC', 'Europe/Amsterdam']);
  const opensslVersion = randomItem(['OpenSSL 3.0.11 19 Sep 2023', 'OpenSSL 3.0.13 30 Jan 2024']);
  const curlVersion = randomItem(['8.5.0', '8.6.0', '8.7.1']);

  const infoRows = [
    ['System', `Linux ${systemHost} ${systemKernel} x86_64`],
    ['Build Date', buildDate],
    ['Build System', 'Linux'],
    ['Server API', profile.serverApi],
    ['Virtual Directory Support', 'disabled'],
    ['Configuration File (php.ini) Path', `/etc/php/${phpSeries}/${profile.serverApi === 'Apache 2.0 Handler' ? 'apache2' : profile.serverApi === 'FPM/FastCGI' ? 'fpm' : 'cgi'}`],
    ['Loaded Configuration File', profile.phpIniPath],
    ['Scan this dir for additional .ini files', profile.iniScanDir],
    ['PHP API', extensionApi],
    ['PHP Extension', extensionApi],
    ['Zend Extension', extensionApi],
    ['Zend Extension Build', `API${extensionApi},NTS`],
    ['PHP Extension Build', `API${extensionApi},NTS`],
    ['Debug Build', 'no'],
    ['Thread Safety', profile.threadSafety],
    ['Zend Signal Handling', 'enabled'],
    ['Zend Memory Manager', 'enabled'],
    ['Zend Multibyte Support', 'disabled'],
    ['IPv6 Support', 'enabled'],
    ['DTrace Support', 'disabled'],
    ['Registered PHP Streams', 'https, ftps, compress.zlib, php, file, glob, data, http, ftp'],
    ['Registered Stream Socket Transports', 'tcp, udp, unix, ssl, tls, tlsv1.2, tlsv1.3'],
    ['Registered Stream Filters', 'zlib.*, string.rot13, string.toupper, string.tolower, convert.*, consumed, dechunk'],
  ];

  const directiveRows = [
    ['allow_url_fopen', 'On', 'On'],
    ['display_errors', 'Off', 'Off'],
    ['error_log', '/var/log/php/error.log', '/var/log/php/error.log'],
    ['expose_php', 'On', 'On'],
    ['file_uploads', 'On', 'On'],
    ['log_errors', 'On', 'On'],
    ['max_execution_time', maxExecutionTime, maxExecutionTime],
    ['max_input_time', maxInputTime, maxInputTime],
    ['max_input_vars', maxInputVars, maxInputVars],
    ['memory_limit', memoryLimit, memoryLimit],
    ['post_max_size', postMaxSize, postMaxSize],
    ['session.save_path', sessionSavePath, sessionSavePath],
    ['sys_temp_dir', tempDir, tempDir],
    ['upload_max_filesize', uploadMaxFilesize, uploadMaxFilesize],
    ['date.timezone', timezone, timezone],
    ['default_socket_timeout', '60', '60'],
  ];

  const serverRows = [
    ['SERVER_SOFTWARE', profile.serverSoftware],
    ['SERVER_NAME', serverName],
    ['SERVER_ADDR', localAddr],
    ['SERVER_PORT', serverPort],
    ['REMOTE_ADDR', remoteAddr],
    ['DOCUMENT_ROOT', '/var/www/html'],
    ['REQUEST_SCHEME', serverPort === '443' ? 'https' : 'http'],
    ['REQUEST_METHOD', method],
    ['REQUEST_URI', requestUri],
    ['QUERY_STRING', queryString],
    ['SCRIPT_NAME', '/phpinfo.php'],
    ['SCRIPT_FILENAME', '/var/www/html/phpinfo.php'],
    ['SERVER_PROTOCOL', 'HTTP/1.1'],
    ['HTTP_HOST', host],
    ['HTTP_USER_AGENT', userAgent],
    ['HTTP_ACCEPT', '*/*'],
    ['UNIQUE_ID', uniqueId],
    ['PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    ['REQUEST_TIME', String(startupDate)],
    ['REQUEST_TIME_FLOAT', `${startupDate}.${crypto.randomInt(100000, 999999)}`],
  ];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>phpinfo()</title>
<style>
body { background-color: #fff; color: #222; font-family: sans-serif; margin: 0; }
a { color: #000099; text-decoration: none; background-color: transparent; }
a:hover { text-decoration: underline; }
h1 { font-size: 150%; margin: 1rem 1rem 0.5rem; }
h2 { font-size: 125%; margin: 1rem; }
table { border-collapse: collapse; margin: 0 1rem 1rem; width: calc(100% - 2rem); }
td, th { border: 1px solid #666; font-size: 0.85rem; padding: 4px 6px; vertical-align: baseline; }
th { background-color: #9999cc; color: #fff; text-align: left; }
.e { background-color: #ccccff; color: #000; font-weight: bold; width: 30%; }
.v { background-color: #eeeeee; color: #000; width: 70%; word-break: break-word; }
.center { text-align: center; }
</style>
</head>
<body>
<h1 class="p">PHP Version ${escapeHtml(phpVersion)}</h1>
<table role="presentation">
<tr><th colspan="2">PHP Core</th></tr>
${renderInfoRows(infoRows)}
</table>
<h2>Configuration</h2>
<table role="presentation">
<tr><th>Directive</th><th>Local Value</th><th>Master Value</th></tr>
${renderDirectiveRows(directiveRows)}
</table>
<h2>Module Settings</h2>
<table role="presentation">
<tr><th colspan="2">curl</th></tr>
${renderInfoRows([
  ['cURL support', 'enabled'],
  ['cURL Information', `${curlVersion} (${opensslVersion})`],
  ['Age', String(crypto.randomInt(5, 11))],
])}
</table>
<table role="presentation">
<tr><th colspan="2">openssl</th></tr>
${renderInfoRows([
  ['OpenSSL support', 'enabled'],
  ['OpenSSL Library Version', opensslVersion],
  ['OpenSSL Header Version', opensslVersion],
])}
</table>
<h2>\$_SERVER</h2>
<table role="presentation">
<tr><th>Variable</th><th>Value</th></tr>
${renderInfoRows(serverRows)}
</table>
<div class="center">
<table role="presentation" style="max-width: 780px; margin: 0 auto 1rem;">
<tr><td class="e">Zend Engine v${escapeHtml(zendVersion)}</td><td class="v">with Zend OPcache v${escapeHtml(phpVersion)}, Copyright (c), by Zend Technologies</td></tr>
</table>
</div>
</body>
</html>`;

  return {
    html,
    phpVersion,
  };
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
    Number.isFinite(envConfiguredMax) && envConfiguredMax > 0 ? envConfiguredMax : 2048;
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
    setNoCacheHeaders(res);
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

  const handlePhpInfoRequest = (req, res) => {
    setNoCacheHeaders(res);
    let clientIp = 'unknown';
    try {
      clientIp = getClientIp(req) || 'unknown';
      addHoneypotHit(clientIp);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to record honeypot hit', error);
    }

    const payload = generateFakePhpInfoPage(req, {clientIp});
    res.type('text/html');
    res.set('X-Powered-By', `PHP/${payload.phpVersion}`);
    if (req.method === 'HEAD') {
      res.set('Content-Length', Buffer.byteLength(payload.html));
      res.status(200).end();
      return;
    }
    res.send(payload.html);
  };

  const handleAdminConfigRequest = (req, res) => {
    setNoCacheHeaders(res);
    res.type('text/plain');
    res.set('X-Powered-By', `PHP/${randomItem(['8.1.32', '8.2.28', '8.3.17'])}`);
    try {
      const clientIp = getClientIp(req) || 'unknown';
      addHoneypotHit(clientIp);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to record honeypot hit', error);
    }

    const payload = `${generateFakeAdminConfigFile()}\n`;
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
    handlePhpInfoRequest,
    handleAdminConfigRequest,
    maxRecords,
  };
};
