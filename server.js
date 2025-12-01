import crypto from 'crypto';
import express from 'express';
import http from 'http';
import maxmind from 'maxmind';
import net from 'net';
import path from 'path';
import {fileURLToPath} from 'url';
import Database from 'better-sqlite3';
import {createHoneypotService} from './componets/honeypot.js';
import {SEO_PAGE_PATH_SET, SEO_PAGES_BY_CATEGORY} from './componets/seo-pages.js';
import {registerSeoRoutes} from './componets/seo-routes.js';
import {createSharedReportService} from './componets/shared-report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const LISTEN_ADDRESS = process.env.LISTEN_ADDRESS || '127.0.0.1';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REPORT_TTL_SECONDS = Number.isFinite(Number.parseInt(process.env.REPORT_TTL_SECONDS ?? '', 10))
    ? Number.parseInt(process.env.REPORT_TTL_SECONDS, 10)
    : 24 * 60 * 60;
const REDIS_CONNECT_TIMEOUT_MS = 1000;
const GUIDE_INDEX_CANONICAL_URL = 'http://nossl.sh/guides';

const geoDbPathEnv = process.env.GEOIP_DB_PATH;
const geoDbPath = geoDbPathEnv
    ? (path.isAbsolute(geoDbPathEnv) ? geoDbPathEnv : path.resolve(__dirname, geoDbPathEnv))
    : path.join(__dirname, 'ip-to-country.mmdb');

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

app.use((req, res, next) => {
    res.locals.requestStartTime = process.hrtime.bigint();
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

const loadGeoReader = async () => {

    try {
        return await maxmind.open(geoDbPath);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load GeoIP database', error);
        return null;
    }
};

const geoReader = await loadGeoReader();

const isPrivateIpv4 = (ip) => {

    const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
        return true;
    }

    if (octets[0] === 10) {
        return true;
    }
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
        return true;
    }
    if (octets[0] === 192 && octets[1] === 168) {
        return true;
    }
    if (octets[0] === 127) {
        return true;
    }
    if (octets[0] === 169 && octets[1] === 254) {
        return true;
    }
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;


};

const isPrivateIp = (ip) => {
    if (!ip) {
        return true;
    }
    const normalized = ip.trim();

    if (!maxmind.validate(normalized)) {
        return true;
    }

    if (normalized === '::1') {
        return true;
    }

    if (normalized.startsWith('::ffff:')) {
        const mappedIpv4 = normalized.slice('::ffff:'.length);
        return isPrivateIpv4(mappedIpv4);
    }

    if (net.isIP(normalized) === 4) {
        return isPrivateIpv4(normalized);
    }

    const lower = normalized.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');


};

function countryCodeToFlag(countryCode) {
    // Validate the input to be exactly two characters long and all alphabetic
    if (!countryCode || countryCode.length !== 2 || !/^[a-zA-Z]+$/.test(countryCode)) {
        return '🏳️'; // White Flag Emoji for unknown or invalid country codes
    }

    const code = countryCode.toUpperCase();
    const offset = 127397;

    return Array.from(code).map(letter => String.fromCodePoint(letter.charCodeAt(0) + offset)).join('');
}

const regionDisplayNames = (() => {
    try {
        if (typeof Intl?.DisplayNames === 'function') {
            return new Intl.DisplayNames(['en'], {type: 'region'});
        }
    } catch (error) {
        // ignore
    }
    return null;
})();

const countryCodeToName = (countryCode) => {
    if (!countryCode || typeof countryCode !== 'string') {
        return null;
    }

    const normalized = countryCode.trim().toUpperCase();
    if (normalized.length !== 2) {
        return null;
    }

    if (!regionDisplayNames) {
        return null;
    }

    try {
        return regionDisplayNames.of(normalized) || null;
    } catch (error) {
        return null;
    }
};

export const lookupGeo = (ip) => {
    if (process.env.TEST_IP) {
        ip = process.env.TEST_IP;
    }

    if (!geoReader || isPrivateIp(ip)) {
        return null;
    }
    try {
        const record = geoReader.get(ip);
        if (!record) {
            return null;
        }
        const countryCode = record.country?.iso_code ||
                record.registered_country?.iso_code ||
                record.country_code ||
                null;
        return {
            countryCode:
                countryCode,
            countryFlag: countryCodeToFlag(countryCode),
            countryName:
                record.country?.names?.en ||
                record.registered_country?.names?.en ||
                record.country_name ||
                countryCodeToName(countryCode) ||
                null,
            orgName: record.org || null,
        };
    } catch (error) {
        return null;
    }
};

const sharedReportService = createSharedReportService({
    redisUrl: REDIS_URL,
    ttlSeconds: REPORT_TTL_SECONDS,
    connectTimeoutMs: REDIS_CONNECT_TIMEOUT_MS,
});
const shareReportStore = sharedReportService.store;
const buildShareSnapshot = (baseData) => sharedReportService.buildSnapshot(baseData);
const getShareUrl = (req, reportId) => sharedReportService.getShareUrl(req, reportId);
const buildShareLinkForRequest = async (req, baseData) => {
    if (!shareReportStore.isAvailable() || !baseData) {
        return {shareReportUrl: null, shareReportId: null};
    }

    try {
        const snapshot = buildShareSnapshot(baseData);
        const shareReportId = await shareReportStore.saveSnapshot(snapshot);
        if (!shareReportId) {
            return {shareReportUrl: null, shareReportId: null};
        }

        return {
            shareReportId,
            shareReportUrl: getShareUrl(req, shareReportId),
        };
    } catch (error) {
        return {shareReportUrl: null, shareReportId: null};
    }
};

const getBaseRequestData = (req, res) => {
    const scheme = getScheme(req);
    const status = scheme === 'https' ? 'Secure connection' : 'Unsecure connection';
    const headers = normalizeHeaders(req.headers);
    const clientIp = getClientIp(req);
    const clientIpv6 = extractClientIpv6(clientIp);
    const geo = lookupGeo(clientIp);
    const requestMethod = req.method;
    const requestPath = req.originalUrl || req.url || req.path;
    const host = req.get('host') || '';
    const httpVersion = req.httpVersion;
    const remotePort = req.socket?.remotePort;
    const localPort = req.socket?.localPort;
    const remoteAddress = req.socket?.remoteAddress;
    const localAddress = req.socket?.localAddress;
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;

    return {
        scheme,
        status,
        clientIp,
        clientIpv6,
        headers,
        requestMethod,
        requestPath,
        host,
        httpVersion,
        remotePort,
        localPort,
        remoteAddress,
        localAddress,
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
        geo,
    };
};

app.use('/static', express.static(path.join(__dirname, 'static'), {maxAge: '1h'}));

const faviconPath = path.join(__dirname, 'static', 'favicon.ico');
const NO_BODY_STATUS_CODES = new Set([204, 304]);
const REDIRECT_STATUS_CODES = new Set([300, 301, 302, 303, 307, 308]);

app.get('/favicon.ico', (req, res) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/x-icon');
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

const extractClientIpv6 = (ip) => {
    const normalized = (ip || '').trim();
    if (!normalized || normalized.startsWith('::ffff:')) {
        return null;
    }
    return net.isIP(normalized) === 6 ? normalized : null;
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

    const baseData = getBaseRequestData(req, res);
    const {
        scheme,
        status,
        headers,
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
        requestMethod,
        requestPath,
        host,
        httpVersion,
        remotePort,
        localPort,
        remoteAddress,
        localAddress,
        geo,
    } = baseData;
    const {shareReportId, shareReportUrl} = await buildShareLinkForRequest(req, baseData);

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
        requestMethod,
        requestPath,
        host,
        httpVersion,
        remotePort,
        localPort,
        remoteAddress,
        localAddress,
        geo,
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

app.get('/api/request-info', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.vary('Origin');

    const reportIdParam = req.query?.reportId;
    const reportId = typeof reportIdParam === 'string' ? reportIdParam.trim() : null;
    const scheme = getScheme(req);
    const clientIp = getClientIp(req);
    const clientIpv6 = extractClientIpv6(clientIp);
    const geo = lookupGeo(clientIp);
    const headers = normalizeHeaders(req.headers).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
    }, {});

    if (reportId && clientIpv6 && shareReportStore?.isAvailable?.()) {
        try {
            const snapshot = await shareReportStore.readSnapshot(reportId);
            if (snapshot) {
                const currentIpv6 = snapshot.clientIpv6;
                if (currentIpv6 !== clientIpv6) {
                    await shareReportStore.writeSnapshot(reportId, {
                        ...snapshot,
                        clientIpv6,
                    });
                }
            }
        } catch (error) {
            // Ignore report update failures to keep API responses fast.
        }
    }

    res.json({
        scheme,
        status: scheme === 'https' ? 'secure' : 'insecure',
        clientIp,
        clientIpv6,
        reportId,
        headers,
        geo,
    });
});

app.options('/api/request-info', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.sendStatus(204);
});

app.all('/status/:code', (req, res) => {
    const statusCode = Number.parseInt(req.params.code, 10);
    const requestedLocation = typeof req.query?.location === 'string' ? req.query.location : null;
    const locationHeader = requestedLocation ? requestedLocation.replace(/[\r\n]/g, '').trim() : null;

    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
        res.status(200).json({info: 'Status code must be an integer between 100 and 599'});
        return;
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');

    if (locationHeader && REDIRECT_STATUS_CODES.has(statusCode)) {
        res.set('Location', locationHeader);
    }

    if ((statusCode >= 100 && statusCode < 200) || NO_BODY_STATUS_CODES.has(statusCode)) {
        res.status(statusCode).end();
        return;
    }

    const description = http.STATUS_CODES[statusCode] || 'Custom Status';
    res.type('text/plain');
    res.status(statusCode).send(`Responding with HTTP ${statusCode}${description ? ` - ${description}` : ''}\n`);
});

app.get('/guides', (req, res) => {
    const baseData = getBaseRequestData(req, res);
    const {
        scheme,
        generatedAt,
        generationTimeMs,
        totalRequests,
    } = baseData;

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.render('seo-directory', {
        categories: SEO_PAGES_BY_CATEGORY,
        scheme,
        generatedAt,
        generationTimeMs,
        totalRequests,
        canonicalUrl: GUIDE_INDEX_CANONICAL_URL,
    });
});

registerSeoRoutes(app, {getBaseRequestData, buildShareLinkForRequest});

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
//listen to localhost and PORT

app.listen(PORT, LISTEN_ADDRESS, () => {
    // eslint-disable-next-line no-console
    console.log(`nossl.sh listening on ${LISTEN_ADDRESS}:${PORT}`);
});
