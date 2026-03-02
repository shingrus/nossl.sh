import crypto from 'crypto';
import express from 'express';
import http from 'http';
import maxmind from 'maxmind';
import net from 'net';
import path from 'path';
import {fileURLToPath} from 'url';
import Database from 'better-sqlite3';
import {createIpRecordService} from './componets/ip-record.js';
import {createAsnInfoStore} from './componets/asn-info.js';
import {createHoneypotService} from './componets/honeypot.js';
import {registerAsnOrgRoutes} from './componets/asn-org-routes.js';
import {registerAsnRoutes} from './componets/asn-routes.js';
import {registerAsnTopRoutes} from './componets/asn-top-routes.js';
import {setNoCacheHeaders} from './componets/cache-headers.js';
import {buildCountryAsnListPath, countryCodeToFlag, countryCodeToName} from './componets/country-utils.js';
import {formatTimestamp} from './componets/format-utils.js';
import {buildOrgSlug} from './componets/org-slug.js';
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
const CANONICAL_BASE_URL = process.env.CANONICAL_BASE_URL?.trim() || 'http://nossl.sh';
const MAINTENANCE_TOKEN = process.env.MAINTENANCE_TOKEN?.trim() || '';

const geoDbPathEnv = process.env.GEOIP_DB_PATH;
const asnDbPathEnv = process.env.ASNIP_DB_PATH;
const asnInfoDbPathEnv = process.env.ASN_INFO_DB_PATH;
const geoDbPath = geoDbPathEnv
    ? (path.isAbsolute(geoDbPathEnv) ? geoDbPathEnv : path.resolve(__dirname, geoDbPathEnv))
    : path.join(__dirname, 'ip-to-country.mmdb');

const asnDbPath = asnDbPathEnv
    ? (path.isAbsolute(asnDbPathEnv) ? asnDbPathEnv : path.resolve(__dirname, asnDbPathEnv))
    : path.join(__dirname, 'ip-to-asn.mmdb');
const asnInfoDbPath = asnInfoDbPathEnv
    ? (path.isAbsolute(asnInfoDbPathEnv) ? asnInfoDbPathEnv : path.resolve(__dirname, asnInfoDbPathEnv))
    : null;

const isDev =  process.env.NODE_ENV === 'development'

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));
app.locals.formatTimestamp = formatTimestamp;
app.locals.isDev = isDev;

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
    'geoIpCount',
    'freeGeoDbCount',
    'apiIpCount',
    'ascounter',
]);

const ensureCounterStmt = db.prepare('INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)');
const incrementCounterStmt = db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?');
const selectCountersStmt = db.prepare(
    `SELECT name, value
     FROM counters
     WHERE name IN (${COUNTER_NAMES.map(() => '?').join(', ')}) LIMIT ${COUNTER_NAMES.length}`,
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

const loadGeoReader = async (geoDb) => {

    try {
        return await maxmind.open(geoDb, {
            watchForUpdates: true,
            watchForUpdatesNonPersistent: true,
            watchForUpdatesHook: () => {
                // eslint-disable-next-line no-console
                console.log(`Reloaded MMDB: ${geoDb}`);
            },
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`Failed to load MMDB database`, error);
        return null;
    }
};

const geoReader = await loadGeoReader(geoDbPath);
const asnReader = await loadGeoReader(asnDbPath);
const asnInfoStore = createAsnInfoStore(asnInfoDbPath);


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

export const lookupGeo = (ip) => {

    if (!geoReader || isPrivateIp(ip)) {
        return null;
    }
    try {
        const record = geoReader.get(ip);
        if (!record) {
            return null;
        }
        const asnRecord = asnReader?  asnReader.get(ip) : null;
        if (isDev) {
            console.log("Geo record" , record);
            if (asnRecord  ) {
                console.log("asn record" , asnRecord) ;
            }
        }
        const countryCode = record.country?.iso_code ||
                record.registered_country?.iso_code ||
                record.country_code ||
                null;
        const cityName = record.city?.names?.en ||
            record.city?.name ||
            record.city_name ||
            null;
        return {
            countryCode:
                countryCode,
            countryFlag: countryCodeToFlag(countryCode) || '🏳️',
            countryName:
                record.country?.names?.en ||
                record.registered_country?.names?.en ||
                record.country_name ||
                countryCodeToName(countryCode) ||
                null,
            cityName,
            orgName: asnRecord ? asnRecord.name : null,
            asn: asnRecord? asnRecord.asn : null,
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
    var clientIp = getClientIp(req);
    const clientIpv6 = extractClientIpv6(clientIp);
    if (process.env.TEST_IP) {
        clientIp = process.env.TEST_IP;
    }
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
const geoMmdbFilename = 'ip2geo-nossl-sh.mmdb';
const asnMmdbFilename = 'ip2asn-nossl-sh.mmdb';
const NO_BODY_STATUS_CODES = new Set([204, 304]);
const REDIRECT_STATUS_CODES = new Set([300, 301, 302, 303, 307, 308]);
const BEACON_HOST_SUFFIX = '.r.nossl.sh';

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

const   getHostnameFromHostHeader = (req) => {
    const hostHeader = typeof req.get === 'function' ? req.get('host') : '';
    if (!hostHeader) {
        return '';
    }
    const rawHost = hostHeader.split(',')[0].trim().toLowerCase();
    if (!rawHost) {
        return '';
    }
    let hostname = rawHost;
    if (hostname.startsWith('[')) {
        const endBracket = hostname.indexOf(']');
        if (endBracket !== -1) {
            hostname = hostname.slice(1, endBracket);
        }
    } else if (hostname.includes(':')) {
        hostname = hostname.split(':')[0];
    }
    if (hostname.endsWith('.')) {
        hostname = hostname.slice(0, -1);
    }
    return hostname;
};

const getBeaconUniqFromHostname = (hostname) => {
    if (!hostname || !hostname.endsWith(BEACON_HOST_SUFFIX)) {
        return null;
    }
    const prefix = hostname.slice(0, -BEACON_HOST_SUFFIX.length);
    const parts = prefix.split('.').filter(Boolean);
    if (parts.length === 0) {
        return null;
    }
    return parts[0];
};

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

const getResolverAsnDetails = (ip) => {
    const resolverIp = trimString(ip);
    if (!resolverIp || !asnReader || isPrivateIp(resolverIp)) {
        return {
            resolver_org: '',
            resolver_name: '',
            resolver_asn: null,
            resolver_org_slug: '',
        };
    }

    try {
        const asnRecord = asnReader.get(resolverIp);
        const resolverOrg = trimString(asnRecord?.org || asnRecord?.organization);
        const resolverOrgSlug = buildOrgSlug(resolverOrg) || '';
        const resolverAsn = Number.isSafeInteger(asnRecord?.asn) ? asnRecord.asn : null;
        return {
            resolver_org: resolverOrg,
            resolver_name: trimString(asnRecord?.name),
            resolver_asn: resolverAsn,
            resolver_org_slug: resolverOrgSlug,
        };
    } catch (error) {
        return {
            resolver_org: '',
            resolver_name: '',
            resolver_asn: null,
            resolver_org_slug: '',
        };
    }
};

const enrichBeaconPayloadWithResolverDetails = (payload) => {
    if (!payload || typeof payload !== 'object') {
        return payload;
    }

    const resolverIp = trimString(payload.resolver_ip || payload.resolver_ip_a || payload.resolver_ip_aaaa);
    return {
        ...payload,
        resolver_ip: resolverIp,
        ...getResolverAsnDetails(resolverIp),
    };
};

const updateReportResolverIp = (reportId, resolverIp) => {
    const trimmedReportId = trimString(reportId);
    const trimmedResolverIp = trimString(resolverIp);
    if (!trimmedReportId || !trimmedResolverIp || !shareReportStore?.isAvailable?.()) {
        return;
    }

    // Fire and forget: don't block the beacon response on Redis writes.
    (async () => {
        try {
            const snapshot = await shareReportStore.readSnapshot(trimmedReportId);
            if (!snapshot) {
                return;
            }
            const existingResolverIp = (snapshot.resolverIp || snapshot.resolver_ip || '').trim();
            if (existingResolverIp) {
                return;
            }
            await shareReportStore.writeSnapshot(trimmedReportId, {
                ...snapshot,
                resolverIp: trimmedResolverIp,
            });
        } catch (error) {
            // Ignore resolver IP update failures to keep responses fast.
        }
    })();
};

const getLookupIp = (req) => {
    const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
    const queryIndex = originalUrl.indexOf('?');
    if (queryIndex === -1) {
        return null;
    }
    const rawQuery = originalUrl.slice(queryIndex + 1).trim();
    if (!rawQuery || rawQuery.includes('=') || rawQuery.includes('&')) {
        return null;
    }

    let candidate;
    try {
        candidate = decodeURIComponent(rawQuery).trim();
    } catch (error) {
        return null;
    }

    return net.isIP(candidate) ? candidate : null;
};

const getLookupQuery = (req) => {
    const queryValue = req.query?.q;
    if (typeof queryValue === 'string') {
        const trimmed = queryValue.trim();
        if (trimmed) {
            return trimmed;
        }
    }

    const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
    const queryIndex = originalUrl.indexOf('?');
    if (queryIndex === -1) {
        return null;
    }
    const rawQuery = originalUrl.slice(queryIndex + 1).trim();
    if (!rawQuery || rawQuery.includes('=') || rawQuery.includes('&')) {
        return null;
    }

    try {
        const candidate = decodeURIComponent(rawQuery).trim();
        return candidate || null;
    } catch (error) {
        return null;
    }
};

const extractClientIpv6 = (ip) => {
    const normalized = (ip || '').trim();
    if (!normalized || normalized.startsWith('::ffff:')) {
        return null;
    }
    return net.isIP(normalized) === 6 ? normalized : null;
};

const extractClientIpv4 = (ip) => {
    const normalized = (ip || '').trim();
    if (!normalized) {
        return null;
    }
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        return net.isIP(mapped) === 4 ? mapped : null;
    }
    return net.isIP(normalized) === 4 ? normalized : null;
};

const getScheme = (req) => {
    const forwardedProto = req.headers['x-forwarded-proto'];
    if (forwardedProto) {
        return forwardedProto.split(',')[0].trim().toLowerCase();
    }
    return req.secure ? 'https' : 'http';
};

const honeypotService = createHoneypotService(db, {getClientIp});
const ipRecordService = createIpRecordService(db);
const selectDistinctIpsForGeoCoverageStmt = db.prepare(`
    SELECT DISTINCT ip
    FROM ip_records
    LIMIT ?
`);
const selectAllDistinctIpsStmt = db.prepare(`
    SELECT DISTINCT ip
    FROM ip_records
`);
const GEO_IP_COVERAGE_CACHE_TTL_MS = 30 * 1000;
let geoIpCoverageCache = null;

const getGeoCoverageSemaphore = (coveragePercent, allIpCount) => {
    if (!allIpCount) {
        return {
            level: 'none',
            label: 'No data',
            description: 'No tracked IPs yet.',
        };
    }
    if (coveragePercent >= 80) {
        return {
            level: 'good',
            label: 'Green',
            description: 'Coverage looks healthy.',
        };
    }
    if (coveragePercent >= 50) {
        return {
            level: 'warn',
            label: 'Yellow',
            description: 'Coverage is partial; refresh GeoIP data soon.',
        };
    }
    return {
        level: 'bad',
        label: 'Red',
        description: 'Coverage is low; GeoIP data likely stale or sparse.',
    };
};

const getGeoIpCoverageStats = () => {
    const now = Date.now();
    if (geoIpCoverageCache && now < geoIpCoverageCache.expiresAt) {
        return geoIpCoverageCache.value;
    }

    const sampleLimit = ipRecordService.maxRecords;
    try {
        const rows = selectDistinctIpsForGeoCoverageStmt.all(sampleLimit);
        let knownIpCount = 0;

        rows.forEach(({ip}) => {
            const cityName = lookupGeo(ip)?.cityName;
            if (typeof cityName === 'string' && cityName.trim()) {
                knownIpCount += 1;
            }
        });

        const allIpCount = rows.length;
        const coveragePercent = allIpCount > 0 ? (knownIpCount / allIpCount) * 100 : 0;
        const value = {
            knownIpCount,
            allIpCount,
            sampleLimit,
            coveragePercent,
            semaphore: getGeoCoverageSemaphore(coveragePercent, allIpCount),
        };

        geoIpCoverageCache = {
            expiresAt: now + GEO_IP_COVERAGE_CACHE_TTL_MS,
            value,
        };
        return value;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to compute GeoIP coverage stats', error);
        return geoIpCoverageCache?.value || {
            knownIpCount: 0,
            allIpCount: 0,
            sampleLimit,
            coveragePercent: 0,
            semaphore: getGeoCoverageSemaphore(0, 0),
        };
    }
};

const getUnknownIpRows = () => {
    try {
        const unknownRows = [];
        const rows = selectAllDistinctIpsStmt.all();

        rows.forEach(({ip}) => {
            const cityName = lookupGeo(ip)?.cityName;
            if (typeof cityName === 'string' && cityName.trim()) {
                return;
            }
            unknownRows.push(ip);
        });

        return unknownRows;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to fetch unknown IP rows', error);
        return [];
    }
};

const isMaintenanceTokenAuthorized = (req) => {
    if (!MAINTENANCE_TOKEN) {
        return false;
    }
    const token = req.get('X-Token');
    return typeof token === 'string' && token.trim() === MAINTENANCE_TOKEN;
};

const recordEndpointIp = (endpoint, clientIp) => {
    try {
        ipRecordService.addIpRecord(endpoint, clientIp);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to record endpoint IP', error);
    }
};

const recordEndpointIpAfterResponse = (res, endpoint, clientIp) => {
    res.once('finish', () => {
        setImmediate(() => {
            recordEndpointIp(endpoint, clientIp);
        });
    });
};

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

    if (req.path.startsWith('/api')) {
        countersToBump.add('apiCount');
    }

    if (req.path === '/api/ip') {
        countersToBump.add('apiIpCount');
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

    if (req.path === '/free-geo-ip') {
        countersToBump.add('geoIpCount');
    }
    if (req.path === '/free-geo-ip-database') {
        countersToBump.add('freeGeoDbCount');
    }

    if (req.path.startsWith('/honeypot')) {
        countersToBump.add('honeypotCount');
    }
    else if (req.path.startsWith('/report')) {
        countersToBump.add('reportCount');
    }
    else if (/^\/as\d+$/.test(req.path)) {//|| /^\/api\/as\d+$/.test(req.path)) {
        countersToBump.add('ascounter');
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

    setNoCacheHeaders(res, {includeLegacy: true});

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

        setNoCacheHeaders(res, {includeLegacy: true});
        res.type('text/html');
        res.send(`<!DOCTYPE html><html lang="en-US"><head><meta charset="utf-8"><title>Redirecting...</title></head><body><script>window.location.href='${redirectUrl}';</script></body></html>`);
        return;
    }

    await renderIndex(req, res);
});

app.get('/check', async (req, res) => {
    await renderIndex(req, res);
});

app.get('/free-geo-ip-database', (req, res) => {
    const baseData = getBaseRequestData(req, res) || {};
    const {generatedAt, generationTimeMs, clientIp, geo} = baseData;

    setNoCacheHeaders(res, {includeLegacy: true});

    res.render('free-geo-ip-database', {
        generatedAt,
        generationTimeMs,
        clientIp,
        geo,
        geoMmdbFilename,
        asnMmdbFilename,
        canonicalUrl: new URL('/free-geo-ip-database', CANONICAL_BASE_URL).toString(),
    });
});

app.get('/free-geo-ip', (req, res) => {
    const clientIp = getClientIp(req);
    const lookupQueryIp = getLookupIp(req);
    const ip = (lookupQueryIp|| process.env.TEST_IP  || clientIp || '').trim();
    const reportGeo = ip ? lookupGeo(ip) : null;
    const countryPath = reportGeo
        ? buildCountryAsnListPath(reportGeo.countryCode || reportGeo.countryName)
        : null;
    const {generatedAt, generationTimeMs} = getRenderMeta(res);

    setNoCacheHeaders(res, {includeLegacy: true});

    res.render('free-geo-ip', {
        ip,
        reportGeo,
        countryPath,
        generatedAt,
        generationTimeMs,
        canonicalUrl: new URL('/free-geo-ip', CANONICAL_BASE_URL).toString(),
    });
});

app.get('/lookup', (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const rawLookup = getLookupQuery(req);
    const lookupValue = typeof rawLookup === 'string' ? rawLookup.trim().slice(0, 200) : '';

    if (!lookupValue) {
        res.status(400);
        res.render('lookup-not-found', {
            lookupValue: '',
            message: 'Enter an IP address, ASN, or organization name to look it up.',
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    if (net.isIP(lookupValue)) {
        const encoded = encodeURIComponent(lookupValue);
        res.redirect(`/free-geo-ip?${encoded}`);
        return;
    }

    const asnMatch = lookupValue.match(/^(?:as|asn)?\s*(\d+)$/i);
    if (asnMatch) {
        const asnNumber = asnInfoStore.parseAsnNumber(asnMatch[1]);
        if (asnNumber && asnInfoStore.isAvailable()) {
            const asnInfo = asnInfoStore.getAsnInfo(asnNumber);
            if (asnInfo) {
                res.redirect(`/as${asnNumber}`);
                return;
            }
        }
        const asnLabel = asnNumber ?? asnMatch[1];
        res.status(404);
        res.render('lookup-not-found', {
            lookupValue,
            message: `Nothing found for ASN ${asnLabel}.`,
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    if (asnInfoStore.isAvailable() && typeof asnInfoStore.findOrgByPrefix === 'function') {
        const orgMatch = asnInfoStore.findOrgByPrefix(lookupValue);
        if (orgMatch?.slug) {
            res.redirect(`/asn-${orgMatch.slug}`);
            return;
        }
    }

    res.status(404);
    res.render('lookup-not-found', {
        lookupValue,
        message: `Nothing found for "${lookupValue}".`,
        generatedAt,
        generationTimeMs,
    });
});

app.all(/^.*\/\.env*/i, honeypotService.handleEnvRequest);
app.all(/^.*\/phpinfo\.php.*/i, honeypotService.handlePhpInfoRequest);
app.all(/^.*\/admin\/config\.php.*/i, honeypotService.handleAdminConfigRequest);

app.get('/api/counters', (req, res) => {
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;

    setNoCacheHeaders(res);
    res.json({
        counters,
        totalRequests,
    });
});

app.get('/api/unknown', (req, res) => {
    setNoCacheHeaders(res);
    if (!isMaintenanceTokenAuthorized(req)) {
        res.sendStatus(404);
        return;
    }

    res.json(getUnknownIpRows());
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
    recordEndpointIpAfterResponse(res, '/api/request-info', clientIp);
    const clientIpv4 = extractClientIpv4(clientIp);
    const clientIpv6 = extractClientIpv6(clientIp);
    const geo = lookupGeo(clientIp);
    const headers = normalizeHeaders(req.headers).reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
    }, {});

    if (reportId && (clientIpv4 || clientIpv6) && shareReportStore?.isAvailable?.()) {
        try {
            const snapshot = await shareReportStore.readSnapshot(reportId);
            if (snapshot) {
                const updates = {};
                if (clientIpv6 && snapshot.clientIpv6 !== clientIpv6) {
                    updates.clientIpv6 = clientIpv6;
                }
                if (clientIpv4 && snapshot.clientIpv4 !== clientIpv4) {
                    updates.clientIpv4 = clientIpv4;
                }
                if (Object.keys(updates).length > 0) {
                    await shareReportStore.writeSnapshot(reportId, {
                        ...snapshot,
                        ...updates,
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
        clientIpv4,
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

app.get('/api/ip', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.vary('Origin');

    setNoCacheHeaders(res);

    const lookupQueryIp = getLookupIp(req);
    const clientIp = getClientIp(req);
    const ip = (lookupQueryIp || process.env.TEST_IP || clientIp || '').trim();
    if (!ip) {
        res.status(400).json({error: 'missing_ip'});
        return;
    }

    const geo = lookupGeo(ip);
    if (!geo) {
        res.status(404).json({error: 'not_found', ip});
        return;
    }

    res.json({ip, ...geo});
});

app.options('/api/ip', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.sendStatus(204);
});

app.get('/api/beacon', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.vary('Origin');
    const clientIp = getClientIp(req);
    recordEndpointIpAfterResponse(res, '/api/beacon', clientIp);

    setNoCacheHeaders(res);

    const reportIdParam = req.query?.reportId;
    const reportId = typeof reportIdParam === 'string' ? reportIdParam.trim() : null;

    if (process.env.TEST_IP) {
        const payload = enrichBeaconPayloadWithResolverDetails({resolver_ip: process.env.TEST_IP});
        res.json(payload);
        updateReportResolverIp(reportId, payload.resolver_ip);
        return;
    }

    const hostname = getHostnameFromHostHeader(req);
    const uniq = getBeaconUniqFromHostname(hostname);
    if (!uniq) {
        res.status(400).json({error: 'missing key'});
        return;
    }

    const key = `beacon:${uniq}`;
    const hashPayload = await shareReportStore.readHashByKey?.(key);
    const rawPayload = hashPayload
        ? (() => {
            const toNumber = (value) => {
                const parsed = Number.parseInt(value, 10);
                return Number.isFinite(parsed) ? parsed : null;
            };
            const resolverIp =
                (hashPayload.resolver_ip ||
                    hashPayload.resolver_ip_a ||
                    hashPayload.resolver_ip_aaaa ||
                    '').trim();
            const normalized = {
                resolver_ip: resolverIp,
                ecs: hashPayload.ecs || '',
                qtype: hashPayload.qtype || '',
                ts: toNumber(hashPayload.ts),
            };
            if (hashPayload.resolver_ip_a) {
                normalized.resolver_ip_a = hashPayload.resolver_ip_a;
            }
            if (hashPayload.resolver_ip_aaaa) {
                normalized.resolver_ip_aaaa = hashPayload.resolver_ip_aaaa;
            }
            if (hashPayload.ecs_a) {
                normalized.ecs_a = hashPayload.ecs_a;
            }
            if (hashPayload.ecs_aaaa) {
                normalized.ecs_aaaa = hashPayload.ecs_aaaa;
            }
            const tsA = toNumber(hashPayload.ts_a);
            if (tsA !== null) {
                normalized.ts_a = tsA;
            }
            const tsAaaa = toNumber(hashPayload.ts_aaaa);
            if (tsAaaa !== null) {
                normalized.ts_aaaa = tsAaaa;
            }
            return normalized;
        })()
        : await shareReportStore.readJsonByKey?.(key);
    if (!rawPayload) {
        if (!shareReportStore.isAvailable?.()) {
            res.status(503).json({error: 'no light'});
            return;
        }
        res.status(404).json({error: 'the lights went off', uniq});
        return;
    }

    const payload = enrichBeaconPayloadWithResolverDetails(rawPayload);
    res.json(payload);
    updateReportResolverIp(reportId, payload.resolver_ip);
});

app.options('/api/beacon', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.sendStatus(204);
});

app.all('/status/:code', (req, res) => {
    const statusCode = Number.parseInt(req.params.code, 10);
    const requestedLocation = typeof req.query?.location === 'string' ? req.query.location : null;
    const locationHeader = requestedLocation ? requestedLocation.replace(/[\r\n]/g, '').trim() : null;

    setNoCacheHeaders(res);

    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
        res.status(200).json({info: 'Status code must be an integer between 100 and 599'});
        return;
    }

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

    setNoCacheHeaders(res, {includeLegacy: true});

    res.render('seo-directory', {
        categories: SEO_PAGES_BY_CATEGORY,
        scheme,
        generatedAt,
        generationTimeMs,
        totalRequests,
        canonicalUrl: new URL('/guides', CANONICAL_BASE_URL).toString(),
    });
});

app.get('/disclaimer', (req, res) => {
    const baseData = getBaseRequestData(req, res) || {};
    const generatedAt = baseData.generatedAt || new Date();
    const generationTimeMs = typeof baseData.generationTimeMs === 'number' ? baseData.generationTimeMs : null;
    const scheme = baseData.scheme || 'http';

    setNoCacheHeaders(res, {includeLegacy: true});

    res.render('disclaimer', {
        ...baseData,
        generatedAt,
        generationTimeMs,
        scheme,
        canonicalUrl: new URL('/disclaimer', CANONICAL_BASE_URL).toString(),
    });
});

app.get('/ss', (req, res) => {
    const baseData = getBaseRequestData(req, res);
    const {generatedAt, generationTimeMs, counters, totalRequests} = baseData;
    const geoIpCoverage = getGeoIpCoverageStats();

    setNoCacheHeaders(res, {includeLegacy: true});
    res.render('service-status', {
        generatedAt,
        generationTimeMs,
        counters,
        totalRequests,
        geoIpCoverage,
    });
});

registerSeoRoutes(app, {getBaseRequestData, buildShareLinkForRequest, canonicalBaseUrl: CANONICAL_BASE_URL});
registerAsnOrgRoutes(app, {asnInfoStore, getRenderMeta, canonicalBaseUrl: CANONICAL_BASE_URL});
registerAsnRoutes(app, {asnInfoStore, getRenderMeta, canonicalBaseUrl: CANONICAL_BASE_URL});
registerAsnTopRoutes(app, {asnInfoStore, getRenderMeta, canonicalBaseUrl: CANONICAL_BASE_URL});

app.get('/healthz', (req, res) => {
    res.json({status: 'ok'});
});

app.get('/api/honeypot', (req, res) => {
    const summary = honeypotService.getSummary();
    setNoCacheHeaders(res);
    res.json({
        totalHits: summary.totalHits,
        uniqueIpCount: summary.uniqueIpCount,
        maxRecords: honeypotService.maxRecords,
        counts: summary.counts,
    });
});

app.get('/report/:reportId', async (req, res) => {
    const {reportId} = req.params;
    setNoCacheHeaders(res);
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

    setNoCacheHeaders(res);
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
