const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerAsnRoutes expected a function for ${name}`);
    }
    return value;
};

const requireAsnStore = (value) => {
    if (
        !value ||
        typeof value.parseAsnNumber !== 'function' ||
        typeof value.getAsnInfo !== 'function' ||
        typeof value.isAvailable !== 'function'
    ) {
        throw new TypeError('registerAsnRoutes requires an ASN info store');
    }
    return value;
};

const buildAsnPageTitle = (asnNumber, orgName, handle) => {
    const titleSuffix = orgName || handle;
    return titleSuffix ? `AS${asnNumber} - ${titleSuffix}` : `AS${asnNumber}`;
};

const buildAsnPageDescription = (asnNumber, orgName, domain, ipv4Count, ipv6Count) => {
    let description = `Autonomous System ${asnNumber}`;
    if (orgName) {
        description += ` (${orgName})`;
    }
    if (domain) {
        description += ` for ${domain}`;
    }
    if (ipv4Count || ipv6Count) {
        description += `. Prefixes: IPv4 ${ipv4Count}`;
        if (ipv6Count) {
            description += `, IPv6 ${ipv6Count}`;
        }
        description += '.';
    } else {
        description += '. ASN details and prefix list.';
    }
    return description;
};

const trimString = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

const normalizePrefix = (entry) => {
    if (typeof entry === 'string') {
        return entry;
    }
    if (entry && typeof entry === 'object') {
        for (const key of ['prefix', 'cidr', 'network', 'subnet']) {
            if (typeof entry[key] === 'string') {
                return entry[key];
            }
        }
    }
    return null;
};

const extractPrefixes = (asnData, family) => {
    if (!asnData || typeof asnData !== 'object') {
        return [];
    }
    for (const containerKey of ['prefixes', 'subnets']) {
        const container = asnData[containerKey];
        if (container && typeof container === 'object') {
            const prefixes = container[family];
            if (Array.isArray(prefixes)) {
                return prefixes.map(normalizePrefix).filter(Boolean);
            }
        }
    }
    const topLevel = asnData[family];
    if (Array.isArray(topLevel)) {
        return topLevel.map(normalizePrefix).filter(Boolean);
    }
    return [];
};

const extractOrgName = (asnData) => {
    const metadata = asnData?.metadata;
    return (
        trimString(metadata?.description) ||
        trimString(asnData?.description) ||
        trimString(asnData?.organization) ||
        trimString(asnData?.Organization)
    );
};

const extractHandle = (asnData) => {
    const metadata = asnData?.metadata;
    return trimString(metadata?.handle) || trimString(asnData?.handle);
};

const createAsnApiHandler = ({asnInfoStore}) => (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    const asnNumber = asnInfoStore.parseAsnNumber(req.params.asn);
    if (!asnNumber) {
        res.status(400).json({error: 'Invalid ASN'});
        return;
    }
    if (!asnInfoStore.isAvailable()) {
        res.status(503).json({error: 'ASN database not configured'});
        return;
    }
    const asnInfo = asnInfoStore.getAsnInfo(asnNumber);
    if (!asnInfo) {
        res.status(404).json({error: 'ASN not found'});
        return;
    }
    const payload = {
        asn: asnInfo.asn,
        domain: asnInfo.domain,
        data: asnInfo.data,
    };
    if (asnInfo.parseError) {
        payload.data = null;
        payload.raw = asnInfo.rawJson;
        payload.parseError = true;
    }
    res.json(payload);
};

const createAsnPageHandler =
    ({asnInfoStore, getRenderMeta, apiPath}) =>
        (req, res) => {
            const {generatedAt, generationTimeMs} = getRenderMeta(res);
            res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');

            const asnParam = req.params.asn;
            const asnNumber = asnInfoStore.parseAsnNumber(asnParam);
            const apiUrl = asnNumber ? `${apiPath}${asnNumber}` : null;

            if (!asnNumber) {
                res.status(400);
                res.render('asn', {
                    asn: asnParam,
                    asnData: null,
                    domain: null,
                    ipv4Prefixes: [],
                    ipv6Prefixes: [],
                    ipv4Count: 0,
                    ipv6Count: 0,
                    ipv4Amount: null,
                    orgName: null,
                    handle: null,
                    pageTitle: 'ASN lookup error',
                    pageDescription: 'Invalid ASN value provided.',
                    errorMessage: 'Invalid ASN value.',
                    rawJson: null,
                    apiUrl: null,
                    generatedAt,
                    generationTimeMs,
                });
                return;
            }

            if (!asnInfoStore.isAvailable()) {
                res.status(503);
                res.render('asn', {
                    asn: asnNumber,
                    asnData: null,
                    domain: null,
                    ipv4Prefixes: [],
                    ipv6Prefixes: [],
                    ipv4Count: 0,
                    ipv6Count: 0,
                    ipv4Amount: null,
                    orgName: null,
                    handle: null,
                    pageTitle: `AS${asnNumber}`,
                    pageDescription: `AS${asnNumber} details are unavailable because the ASN database is not configured.`,
                    errorMessage: 'ASN database is not configured.',
                    rawJson: null,
                    apiUrl,
                    generatedAt,
                    generationTimeMs,
                });
                return;
            }

            const asnInfo = asnInfoStore.getAsnInfo(asnNumber);
            if (!asnInfo) {
                res.status(404);
                res.render('asn', {
                    asn: asnNumber,
                    asnData: null,
                    domain: null,
                    ipv4Prefixes: [],
                    ipv6Prefixes: [],
                    ipv4Count: 0,
                    ipv6Count: 0,
                    ipv4Amount: null,
                    orgName: null,
                    handle: null,
                    pageTitle: `AS${asnNumber}`,
                    pageDescription: `No ASN record found for ${asnNumber}.`,
                    errorMessage: `AS${asnNumber} not found.`,
                    rawJson: null,
                    apiUrl,
                    generatedAt,
                    generationTimeMs,
                });
                return;
            }

            const asnData = asnInfo.data;
            const ipv4Prefixes = extractPrefixes(asnData, 'ipv4');
            const ipv6Prefixes = extractPrefixes(asnData, 'ipv6');
            const orgName = extractOrgName(asnData);
            const handle = extractHandle(asnData);
            const pageTitle = buildAsnPageTitle(asnNumber, orgName, handle);
            const pageDescription = buildAsnPageDescription(
                asnNumber,
                orgName,
                asnInfo.domain,
                ipv4Prefixes.length,
                ipv6Prefixes.length,
            );

            res.render('asn', {
                asn: asnNumber,
                asnData,
                domain: asnInfo.domain,
                ipv4Prefixes,
                ipv6Prefixes,
                ipv4Count: ipv4Prefixes.length,
                ipv6Count: ipv6Prefixes.length,
                ipv4Amount: asnInfo.ipv4Amount ?? null,
                orgName,
                handle,
                pageTitle,
                pageDescription,
                errorMessage: asnInfo.parseError ? 'ASN record could not be parsed.' : null,
                rawJson: asnInfo.parseError ? asnInfo.rawJson : null,
                apiUrl,
                generatedAt,
                generationTimeMs,
            });
        };

export const registerAsnRoutes = (app, helpers = {}) => {
    if (!app || typeof app.get !== 'function') {
        throw new TypeError('registerAsnRoutes requires an express app instance');
    }

    const asnInfoStore = requireAsnStore(helpers.asnInfoStore);
    const getRenderMeta = requireHelper(helpers.getRenderMeta, 'getRenderMeta');
    const asPath = typeof helpers.asPath === 'string' ? helpers.asPath : '/as';
    const apiPath = typeof helpers.apiPath === 'string' ? helpers.apiPath : '/api/as';

    app.get(`${apiPath}:asn`, createAsnApiHandler({asnInfoStore}));
    app.get(`${asPath}:asn`, createAsnPageHandler({asnInfoStore, getRenderMeta, apiPath}));
};
