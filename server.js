import crypto from 'crypto';
import express from 'express';
import path from 'path';
import {fileURLToPath} from 'url';
import Database from 'better-sqlite3';
import {generateFakeEnvFile} from './componets/honeypot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

const dbPathEnv = process.env.SQLDB;
const dbPath = dbPathEnv
    ? (path.isAbsolute(dbPathEnv) ? dbPathEnv : path.resolve(__dirname, dbPathEnv))
    : path.join(__dirname, 'counters.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS counters
    (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
    )
`);
db.exec(`
    CREATE TABLE IF NOT EXISTS honeypot_ips
    (
        ip TEXT PRIMARY KEY,
        hits INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT NOT NULL
    )
`);
const COUNTER_NAMES = Object.freeze([
    'httpCount',
    'httpsCount',
    'apiCount',
    'checkCount',
    'healthzCount',
    'curlCount',
    'rootCount',
]);

const ensureCounterStmt = db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)');
const incrementCounterStmt = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?');
const selectCountersStmt = db.prepare(
    `SELECT name, value
     FROM counters
     WHERE name IN (${COUNTER_NAMES.map(() => '?').join(', ')}) LIMIT 10`,
);

COUNTER_NAMES.forEach((name) => {
    ensureCounterStmt.run(name);
});

const incrementCounters = db.transaction((names) => {
    names.forEach((name) => {
        incrementCounterStmt.run(name);
    });
});

const getCountersSnapshot = () => {
    const snapshot = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
    selectCountersStmt.all(...COUNTER_NAMES).forEach(({name, value}) => {
        snapshot[name] = value;
    });
    return snapshot;
};

const parsedMaxHoneypot = Number.parseInt(process.env.MAX_HONEYPOT ?? '', 10);
const MAX_HONEYPOT_RECORDS = Number.isFinite(parsedMaxHoneypot) && parsedMaxHoneypot > 0 ? parsedMaxHoneypot : 1024;
const HONEYPOT_PRUNE_THRESHOLD = Math.max(MAX_HONEYPOT_RECORDS, Math.ceil(MAX_HONEYPOT_RECORDS * 1.2));

const upsertHoneypotHitStmt = db.prepare(`
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
    upsertHoneypotHitStmt.run(ip, timestamp);
    const {total} = countHoneypotStmt.get();
    if (total > HONEYPOT_PRUNE_THRESHOLD) {
        const toRemove = total - MAX_HONEYPOT_RECORDS;
        if (toRemove > 0) {
            pruneHoneypotStmt.run(toRemove);
        }
    }
});

const addHoneypotHit = (ip) => {
    const timestamp = new Date().toISOString();
    recordHoneypotHit(ip, timestamp);
};

const getHoneypotSummary = () => {
    const totals = honeypotTotalsStmt.get();
    const counts = selectTopHoneypotStmt.all(MAX_HONEYPOT_RECORDS).map(({ip, hits, last_seen: lastSeen}) => ({
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

app.use('/static', express.static(path.join(__dirname, 'static'), {maxAge: '1h'}));

const faviconPath = path.join(__dirname, 'static', 'favicon.svg');

app.get('/favicon.ico', (req, res) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/svg+xml');
    res.sendFile(faviconPath);
});

app.get('/robots.txt', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'static', 'robots.txt'));
});

app.get('/sitemap.xml', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/xml');
    res.sendFile(path.join(__dirname, 'static', 'sitemap.xml'));
});

const getClientIp = (req) => {
    const forwardedFor = req.headers['x-forwarded-for'];
    if (forwardedFor) {
        const ip = forwardedFor.split(',')[0].trim();
        if (ip) {
            return ip;
        }
    }
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
        return realIp;
    }
    return req.ip;
};

const getScheme = (req) => {
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (forwardedProto) {
        return forwardedProto.split(',')[0].trim().toLowerCase();
    }
    return req.secure ? 'https' : 'http';
};

const collectCountersForRequest = (req) => {
    const countersToBump = new Set();
    const scheme = getScheme(req);

    if (req.path === '/check' || req.path === '/' || req.path === '/honeypot') {
        switch (scheme) {
            case 'http':
                countersToBump.add('httpCount');
                break;
            case 'https':
                countersToBump.add('httpsCount');

        }
    }

    if (req.path.startsWith('/api')) {
        countersToBump.add('apiCount');
    }

    if (req.path === '/check') {
        countersToBump.add('checkCount');
    }

    if (req.path === '/') {
        countersToBump.add('rootCount');
    }


    if (req.path === '/healthz') {
        countersToBump.add('healthzCount');
    }

    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    if (userAgent.includes('curl')) {
        countersToBump.add('curlCount');
    }

    return [...countersToBump];
};

app.use((req, res, next) => {
    try {
        const countersToBump = collectCountersForRequest(req);
        if (countersToBump.length > 0) {
            incrementCounters(countersToBump);
        }
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to update counters', error);
    }

    next();
});

const normalizeHeaders = (headers) =>
    Object.entries(headers)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
        .sort((a, b) => a[0].localeCompare(b[0]));

const randomSubdomain = () => {
    const words = [
        'alpha',
        'bravo',
        'charlie',
        'delta',
        'echo',
        'foxtrot',
        'golf',
        'hotel',
        'india',
        'juliet',
        'kilo',
        'lima',
        'mike',
        'november',
        'oscar',
        'papa',
        'quebec',
        'romeo',
        'sierra',
        'tango',
        'uniform',
        'victor',
        'whiskey',
        'xray',
        'yankee',
        'zulu',
    ];
    return words[crypto.randomInt(0, words.length)];
};

const renderIndex = (req, res) => {
    const clientIp = getClientIp(req);
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    if (userAgent.includes('curl')) {
        res.type('text/plain');
        res.send(`${clientIp}\n`);
        return;
    }

    const scheme = getScheme(req);
    const status = scheme === 'https' ? 'Secure connection.' : 'Unsecure connection.';
    const headers = normalizeHeaders(req.headers);
    const generatedAt = new Date();
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;

    res.render('index', {
        scheme,
        status,
        clientIp,
        headers,
        generatedAt,
        counters,
        totalRequests,
    });
};

app.get('/', (req, res) => {
    const scheme = getScheme(req);
    if (scheme === 'https') {
        const subdomain = randomSubdomain();
        const redirectUrl = `http://${subdomain}.nossl.sh/check`;

        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.type('text/html');
        res.send(`<!DOCTYPE html><html lang="en-US"><head><meta charset="utf-8"><title>Redirecting...</title></head><body><script>window.location.href='${redirectUrl}';</script></body></html>`);
        return;
    }

    renderIndex(req, res);
});

app.get('/check', (req, res) => {
    renderIndex(req, res);
});

app.get('/.env', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.type('text/plain');
    try {
        const clientIp = getClientIp(req) || 'unknown';
        addHoneypotHit(clientIp);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to record honeypot hit', error);
    }
    res.send(`${generateFakeEnvFile()}\n`);
});

app.get('/api/counters', (req, res) => {
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.json({
        counters,
        totalRequests,
    });
});

app.get('/api/request-info', (req, res) => {
    const scheme = getScheme(req);
    const clientIp = getClientIp(req);
    const headers = normalizeHeaders(req.headers).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
    }, {});

    res.json({
        scheme,
        status: scheme === 'https' ? 'secure' : 'insecure',
        clientIp,
        headers,
    });
});

app.get('/healthz', (req, res) => {
    res.json({status: 'ok'});
});

app.get('/api/honeypot', (req, res) => {
    const summary = getHoneypotSummary();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.json({
        totalHits: summary.totalHits,
        uniqueIpCount: summary.uniqueIpCount,
        maxRecords: MAX_HONEYPOT_RECORDS,
        counts: summary.counts,
    });
});

app.get('/honeypot', (req, res) => {
    const summary = getHoneypotSummary();
    const rows = summary.counts.map((item, index) => ({
        index: index + 1,
        ...item,
    }));

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.render('honeypot', {
        totalHits: summary.totalHits,
        uniqueIpCount: summary.uniqueIpCount,
        maxRecords: MAX_HONEYPOT_RECORDS,
        rows,
    });
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`nossl.sh listening on port ${PORT}`);
});
