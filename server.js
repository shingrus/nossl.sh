import crypto from 'crypto';
import express from 'express';
import path from 'path';
import {fileURLToPath} from 'url';
import Database from 'better-sqlite3';
import {createClient as createRedisClient} from 'redis';
import {createHoneypotService} from './componets/honeypot.js';
import {SEO_PAGE_PATH_SET} from './componets/seo-pages.js';
import {registerSeoRoutes} from './componets/seo-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REPORT_TTL_SECONDS = Number.isFinite(Number.parseInt(process.env.REPORT_TTL_SECONDS ?? '', 10))
    ? Number.parseInt(process.env.REPORT_TTL_SECONDS, 10)
    : 24 * 60 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 1000;

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

app.use((req, res, next) => {
    res.locals.requestStartTime = process.hrtime.bigint();
    next();
});

app.use((req, res, next) => {
    res.locals.shareReportEnabled = shareReportStore.isAvailable();
    next();
});

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
    'honeypotCount',
    'seoLandingCount',
    'reportCount',
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

const getRenderMeta = (res) => {
    const generatedAt = new Date();
    let generationTimeMs = null;
    const start = res?.locals?.requestStartTime;
    if (typeof start === 'bigint') {
        const durationNs = process.hrtime.bigint() - start;
        generationTimeMs = Number(durationNs) / 1e6;
    }

    return {generatedAt, generationTimeMs};
};

const createShareReportStore = () => {
    let client = null;
    let connectPromise = null;
    let available = false;

    const resetClient = () => {
        const current = client;
        client = null;
        connectPromise = null;
        if (current) {
            current.quit().catch(() => {
                // ignore cleanup errors
            });
        }
    };

    const startConnection = () => {
        if (connectPromise) {
            return connectPromise;
        }

        const nextClient = createRedisClient({
            url: REDIS_URL,
            socket: {
                connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
            },
        });
        client = nextClient;
        nextClient.on('error', () => {
            available = false;
            resetClient();
        });

        connectPromise = nextClient
            .connect()
            .then(() => {
                available = true;
                return nextClient;
            })
            .catch(() => {
                available = false;
                resetClient();
                return null;
            });

        return connectPromise;
    };

    const getClient = async () => {
        const activeClient = await startConnection();
        if (!activeClient) {
            available = false;
            return null;
        }
        return activeClient;
    };

    const saveSnapshot = async (snapshot) => {
        try {
            const redis = await getClient();
            if (!redis) {
                return null;
            }

            const reportId = crypto.randomUUID();
            await redis.set(`shared_report:${reportId}`, JSON.stringify(snapshot), {
                EX: REPORT_TTL_SECONDS,

            });
            available = true;
            return reportId;
        } catch (error) {
            available = false;
            resetClient();
            return null;
        }
    };

    const readSnapshot = async (reportId) => {
        try {
            const redis = await getClient();
            if (!redis) {
                return null;
            }

            const raw = await redis.get(`shared_report:${reportId}`);
            if (!raw) {
                return null;
            }

            try {
                return JSON.parse(raw);
            } catch (error) {
                return null;
            }
        } catch (error) {
            available = false;
            resetClient();
            return null;
        }
    };

    const isAvailable = () => {
        if (!available && !connectPromise) {
            startConnection().catch(() => {
                available = false;
            });
        }
        return available;
    };

    startConnection().catch(() => {
        available = false;
    });

    return {
        isAvailable,
        saveSnapshot,
        readSnapshot,
    };
};

const shareReportStore = createShareReportStore();

const getBaseRequestData = (req, res) => {
    const scheme = getScheme(req);
    const status = scheme === 'https' ? 'Secure connection.' : 'Unsecure connection.';
    const headers = normalizeHeaders(req.headers);
    const clientIp = getClientIp(req);
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;

    return {
        scheme,
        status,
        clientIp,
        headers,
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
    };
};

const buildShareSnapshot = (req, res) => {
    const baseData = getBaseRequestData(req, res);
    return {
        ...baseData,
        generatedAt: baseData.generatedAt.toISOString(),
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

const honeypotService = createHoneypotService(db, {getClientIp});

const collectCountersForRequest = (req) => {
    const countersToBump = new Set();
    const scheme = getScheme(req);

    if (req.path === '/check' || req.path === '/') {
        switch (scheme) {
            case 'http':
                countersToBump.add('httpCount');
                break;
            case 'https':
                countersToBump.add('httpsCount');

        }
    }

    if (req.path === '/') {}
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

    if (req.path.startsWith('/honeypot')) {
        countersToBump.add('honeypotCount');
    }
    else if (req.path.startsWith('/report')) {
        countersToBump.add('reportCount');
    }

    let matchedSeoPath = null;
    if (SEO_PAGE_PATH_SET.has(req.path)) {
        matchedSeoPath = req.path;
    } else {
        try {
            const decodedPath = decodeURIComponent(req.path);
            if (SEO_PAGE_PATH_SET.has(decodedPath)) {
                matchedSeoPath = decodedPath;
            }
        } catch (error) {
            // ignore decoding errors
        }
    }

    if (matchedSeoPath) {
        countersToBump.add('seoLandingCount');
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

const renderIndex = async (req, res) => {
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

    let shareReportUrl = null;
    let shareReportId = null;

    const {
        scheme,
        status,
        headers,
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
    } = getBaseRequestData(req, res);

    if (shareReportStore.isAvailable()) {
        try {
            const snapshot = buildShareSnapshot(req, res);
            shareReportId = await shareReportStore.saveSnapshot(snapshot);
            if (shareReportId) {
                const host = req.get('host') || 'nossl.sh';
                shareReportUrl = `http://${host}/report/${shareReportId}`;
            }
        } catch (error) {
            shareReportId = null;
            shareReportUrl = null;
        }
    }

    res.render('index', {
        scheme,
        status,
        clientIp,
        headers,
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
        shareReportEnabled: Boolean(shareReportUrl),
        shareReportId,
        shareReportUrl,
    });
};

app.get('/', async (req, res) => {
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

    await renderIndex(req, res);
});

app.get('/check', async (req, res) => {
    await renderIndex(req, res);
});

app.all(/^.*\/\.env*/i, honeypotService.handleEnvRequest);

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

registerSeoRoutes(app, {getScheme, getCountersSnapshot, getRenderMeta});

app.get('/healthz', (req, res) => {
    res.json({status: 'ok'});
});

app.get('/api/honeypot', (req, res) => {
    const summary = honeypotService.getSummary();
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.json({
        totalHits: summary.totalHits,
        uniqueIpCount: summary.uniqueIpCount,
        maxRecords: honeypotService.maxRecords,
        counts: summary.counts,
    });
});

app.get('/report/:reportId', async (req, res) => {
    const {reportId} = req.params;
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    const {generatedAt, generationTimeMs} = getRenderMeta(res);

    let report = null;
    if (reportId) {
        try {
            report = await shareReportStore.readSnapshot(reportId);
        } catch (error) {
            report = null;
        }
    }

    if (!report) {
        res.status(410);
    }

    res.render('report', {
        reportId,
        report,
        generatedAt,
        generationTimeMs,
    });
});

app.get('/honeypot', (req, res) => {
    const summary = honeypotService.getSummary();
    const rows = summary.counts.map((item, index) => ({
        index: index + 1,
        ...item,
    }));
    const {generatedAt, generationTimeMs} = getRenderMeta(res);

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.render('honeypot', {
        totalHits: summary.totalHits,
        uniqueIpCount: summary.uniqueIpCount,
        maxRecords: honeypotService.maxRecords,
        rows,
        generatedAt,
        generationTimeMs,
    });
});

app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`nossl.sh listening on port ${PORT}`);
});
