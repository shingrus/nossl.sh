import {buildOrgSlug} from './org-slug.js';
import {formatIpv4Amount} from './asn-format.js';
import {setNoCacheHeaders} from './cache-headers.js';
import {
    buildCountryAsnListPath,
    buildCountrySlug,
    countryCodeToFlag,
    countryCodeToName,
    normalizeCountryCode,
    normalizeCountrySlug,
} from './country-utils.js';

const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerAsnTopRoutes expected a function for ${name}`);
    }
    return value;
};

const requireAsnStore = (value) => {
    if (
        !value ||
        typeof value.isAvailable !== 'function' ||
        typeof value.getTopAsnsByIpv4 !== 'function' ||
        typeof value.getTopAsnsByIpv6 !== 'function' ||
        typeof value.getTopOrganizationsByIpv4 !== 'function' ||
        typeof value.getTopCountriesByIpv4 !== 'function' ||
        typeof value.getAsnsByCountry !== 'function' ||
        typeof value.getCountryAsnCount !== 'function' ||
        typeof value.getCountryList !== 'function' ||
        typeof value.getAsnsForOrg !== 'function'
    ) {
        throw new TypeError('registerAsnTopRoutes requires an ASN info store with ranking helpers');
    }
    return value;
};

const RANKING_PAGES = Object.freeze([
    {path: '/list-of-countries-by-ipv4-allocation', label: 'List of countries by IPv4 allocation'},
    {path: '/top-asn-by-ip-address', label: 'Top ASNs by IPv4'},
    {path: '/top-asn-by-ipv6', label: 'Top ASNs by IPv6'},
    {path: '/top-organizations-by-ip-address', label: 'Top orgs by IPv4'},
]);

const buildPageLinks = (activePath) =>
    RANKING_PAGES.map((page) => ({
        ...page,
        active: page.path === activePath,
    }));

const parseNumber = (value) => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
            return null;
        }
        const parsed = Number.parseFloat(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const parsePageNumber = (value, fallback = 1) => {
    const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

const formatDecimalString = (value) => {
    const trimmed = value.trim();
    const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
    if (!match) {
        return null;
    }
    const whole = formatIpv4Amount(match[1]);
    const decimals = (match[2] || '').padEnd(2, '0').slice(0, 2);
    if (decimals === '00') {
        return whole;
    }
    return `${whole}.${decimals}`;
};

const IPV6_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

const formatNumberWithSpaces = (value) => {
    const formatted = IPV6_NUMBER_FORMATTER.format(value).replace(/,/g, ' ');
    return formatted.endsWith('.00') ? formatted.slice(0, -3) : formatted;
};

const formatIpv6Amount = (value) => {
    if (typeof value === 'string') {
        const formatted = formatDecimalString(value);
        if (formatted) {
            return formatted;
        }
    }
    const parsed = parseNumber(value);
    if (parsed == null || !Number.isFinite(parsed)) {
        return value == null ? 'N/A' : String(value);
    }
    return formatNumberWithSpaces(parsed);
};

const normalizeCountryValue = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

const createCountrySlugIndex = (asnInfoStore) => {
    let cachedIndex = null;
    return () => {
        if (cachedIndex) {
            return cachedIndex;
        }
        const index = new Map();
        const countries = asnInfoStore.getCountryList();
        countries.forEach((countryValue) => {
            const normalized = normalizeCountryValue(countryValue);
            if (!normalized) {
                return;
            }
            const code = normalizeCountryCode(normalized);
            const name = code ? countryCodeToName(code) : null;
            const slugBase = name || normalized;
            const slug = buildCountrySlug(slugBase);
            if (!slug) {
                return;
            }
            const existing = index.get(slug);
            if (!existing) {
                index.set(slug, {country: normalized, code});
                return;
            }
            if (!existing.code && code) {
                index.set(slug, {country: normalized, code});
            }
        });
        cachedIndex = index;
        return index;
    };
};

const resolveCountryFromSlug = (slug, getCountrySlugIndex) => {
    const normalizedSlug = normalizeCountrySlug(slug);
    if (!normalizedSlug) {
        return null;
    }
    const index = getCountrySlugIndex();
    const entry = index.get(normalizedSlug);
    if (entry) {
        return {slug: normalizedSlug, ...entry};
    }
    const code = normalizeCountryCode(normalizedSlug);
    if (code) {
        return {slug: normalizedSlug, country: code, code};
    }
    return null;
};

const getCountryDisplay = (value) => {
    const normalized = normalizeCountryValue(value);
    if (!normalized) {
        return {label: 'Unknown', code: null, name: null, flag: null};
    }
    const code = normalizeCountryCode(normalized);
    if (!code) {
        return {label: normalized, code: null, name: null, flag: null};
    }
    const name = countryCodeToName(code);
    const flag = countryCodeToFlag(code);
    return {
        label: name || code,
        code,
        name,
        flag,
    };
};

const createTopAsnHandler = ({asnInfoStore, getRenderMeta, family}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const isIpv4 = family === 'ipv4';
    const pageTitle = isIpv4 ? 'Top ASNs by IPv4 address space' : 'Top ASNs by IPv6 address space';
    const pageDescription = isIpv4
        ? 'Top 10 ASNs ranked by IPv4 address space, with organization details and related ASNs.'
        : 'Top 10 ASNs ranked by IPv6 address space, with organization details and related ASNs.';
    const heroTitle = pageTitle;
    const heroSubtitle = isIpv4
        ? 'Top ASN Ranked by total announced IPv4 address space. Related ASNs are grouped by organization.'
        : 'Top ASN Ranked by total announced IPv6 address space. Related ASNs are grouped by organization.';
    const showSecondaryAmount = false;
    const ipv4Label = 'IPv4 addresses';
    const ipv6Label = 'IPv6 addresses (mln)';
    const primaryAmountLabel = isIpv4 ? ipv4Label : ipv6Label;
    const secondaryAmountLabel = isIpv4 ? ipv6Label : ipv4Label;
    const pageLinks = buildPageLinks(isIpv4 ? '/top-asn-by-ip-address' : '/top-asn-by-ipv6');

    let errorMessage = null;
    let entries = [];

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        const rows = isIpv4
            ? asnInfoStore.getTopAsnsByIpv4(25)
            : asnInfoStore.getTopAsnsByIpv6(25);
        entries = rows.map((entry) => {
            const relatedAsns = entry.organization
                ? asnInfoStore.getAsnsForOrg(entry.organization, 3, entry.asn)
                : [];
            const orgSlug = entry.organization ? buildOrgSlug(entry.organization) : null;
            return {
                ...entry,
                displayOrganization: entry.organization || 'Unknown org',
                orgSlug,
                relatedAsns,
                primaryAmountDisplay: isIpv4
                    ? formatIpv4Amount(entry.ipv4Amount)
                    : formatIpv6Amount(entry.ipv6Amount),
                secondaryAmountDisplay: isIpv4
                    ? formatIpv6Amount(entry.ipv6Amount)
                    : formatIpv4Amount(entry.ipv4Amount),
            };
        });
    }

    res.render('asn-top', {
        pageTitle,
        pageDescription,
        heroTitle,
        heroSubtitle,
        primaryAmountLabel,
        secondaryAmountLabel,
        showSecondaryAmount,
        entries,
        errorMessage,
        pageLinks,
        generatedAt,
        generationTimeMs,
    });
};

const createTopCountryHandler = ({asnInfoStore, getRenderMeta}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const pageTitle = 'List of countries by IPv4 address allocation';
    const pageDescription = 'Countries ranked by IPv4 address allocation, based on ASN allocations.';
    const heroTitle = pageTitle;
    const heroSubtitle = 'Ranked by total IPv4 address space across ASNs registered in each country.';
    const pageLinks = buildPageLinks('/list-of-countries-by-ipv4-allocation');

    let errorMessage = null;
    let entries = [];

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        const rows = asnInfoStore.getTopCountriesByIpv4(500);
        if (rows == null) {
            errorMessage = 'Country data is not available in the ASN database.';
            res.status(503);
        } else {
            entries = rows.map((entry) => {
                const countryDisplay = getCountryDisplay(entry.country);
                const displayCountry = countryDisplay.flag
                    ? `${countryDisplay.flag} ${countryDisplay.label}`
                    : countryDisplay.label;
                const countryPath = buildCountryAsnListPath(entry.country);
                return {
                    ...entry,
                    displayCountry,
                    countryPath,
                    ipv4AmountDisplay: formatIpv4Amount(entry.ipv4Amount),
                };
            });
        }
    }

    res.render('asn-country-top', {
        pageTitle,
        pageDescription,
        heroTitle,
        heroSubtitle,
        entries,
        errorMessage,
        pageLinks,
        generatedAt,
        generationTimeMs,
    });
};

const createCountryAsnListHandler = ({asnInfoStore, getRenderMeta, getCountrySlugIndex}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const countryParam = req.params?.[0] ?? req.params?.country;
    const countryEntry = resolveCountryFromSlug(countryParam, getCountrySlugIndex);
    const countryValue = countryEntry?.country || null;
    const countryCode = countryEntry?.code || (countryValue ? normalizeCountryCode(countryValue) : null);
    const page = parsePageNumber(req.query?.page, 1);
    const limit = 1000;

    if (!countryValue) {
        res.status(404);
        res.render('asn-top', {
            pageTitle: 'Country lookup error',
            pageDescription: 'Invalid country value.',
            heroTitle: 'Country ASN list',
            heroSubtitle: 'Invalid country value provided.',
            primaryAmountLabel: 'IPv4 addresses',
            secondaryAmountLabel: null,
            showSecondaryAmount: false,
            tableEyebrow: 'Countries',
            tableTitle: 'ASNs by IPv4 address space',
            tableSummary: 'Ordered by total IPv4 address space within this country.',
            showRelatedAsns: false,
            entries: [],
            pageLinks: buildPageLinks(null),
            errorMessage: 'Invalid country value.',
            pagination: null,
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    const requestedSlug = normalizeCountrySlug(countryParam);
    const preferredSlug = buildCountrySlug(countryCodeToName(countryCode) || countryValue);
    if (preferredSlug && requestedSlug && preferredSlug !== requestedSlug) {
        const target = page > 1 ? `/${preferredSlug}-asn-list?page=${page}` : `/${preferredSlug}-asn-list`;
        res.redirect(301, target);
        return;
    }

    let errorMessage = null;
    let entries = [];
    let pagination = null;

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        const totalCount = asnInfoStore.getCountryAsnCount(countryValue);
        if (totalCount == null) {
            errorMessage = 'Country data is not available in the ASN database.';
            res.status(503);
        } else if (!totalCount) {
            errorMessage = `No ASN records found for ${countryCode || countryValue}.`;
            res.status(404);
        } else {
            const totalPages = Math.max(1, Math.ceil(totalCount / limit));
            const safePage = Math.min(page, totalPages);
            const offset = (safePage - 1) * limit;
            const rows = asnInfoStore.getAsnsByCountry(countryValue, limit, offset) || [];
            entries = rows.map((entry, index) => ({
                ...entry,
                rank: offset + index + 1,
                displayOrganization: entry.organization || 'Unknown org',
                orgSlug: entry.organization ? buildOrgSlug(entry.organization) : null,
                ipv4AmountDisplay: formatIpv4Amount(entry.ipv4Amount),
                primaryAmountDisplay: formatIpv4Amount(entry.ipv4Amount),
            }));

            const basePath = buildCountryAsnListPath(countryValue) || '/list-of-countries-by-ipv4-allocation';
            const buildPageUrl = (pageNumber) =>
                pageNumber === 1 ? basePath : `${basePath}?page=${pageNumber}`;
            pagination = {
                page: safePage,
                totalPages,
                totalCount,
                hasPrev: safePage > 1,
                hasNext: safePage < totalPages,
                prevUrl: safePage > 1 ? buildPageUrl(safePage - 1) : null,
                nextUrl: safePage < totalPages ? buildPageUrl(safePage + 1) : null,
            };
        }
    }

    const countryName = countryCode ? countryCodeToName(countryCode) : null;
    const countryFlag = countryCode ? countryCodeToFlag(countryCode) : null;
    const displayCountry = countryFlag
        ? `${countryFlag} ${countryName || countryValue}`
        : countryName || countryValue;
    const pageTitle = `${displayCountry} ASN list by IPv4 address space`;
    const pageDescription = `ASNs registered in ${countryName || countryValue}, ordered by IPv4 address space.`;
    const heroTitle = `${displayCountry} ASNs by IPv4 address space`;
    const heroSubtitle = `Top ASNs in ${countryName || countryValue}, ranked by IPv4 address space.`;

    res.render('asn-top', {
        pageTitle,
        pageDescription,
        heroTitle,
        heroSubtitle,
        primaryAmountLabel: 'IPv4 addresses',
        secondaryAmountLabel: null,
        showSecondaryAmount: false,
        tableEyebrow: 'Countries',
        tableTitle: 'ASNs by IPv4 address space',
        tableSummary: 'Ordered by total IPv4 address space within this country.',
        showRelatedAsns: false,
        entries,
        errorMessage,
        pageLinks: buildPageLinks(null),
        pagination,
        generatedAt,
        generationTimeMs,
    });
};

const createTopOrgHandler = ({asnInfoStore, getRenderMeta}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const pageTitle = 'Top organizations by IPv4 address space';
    const pageDescription = 'Top 10 organizations ranked by IPv4 address space, with related ASNs.';
    const heroTitle = pageTitle;
    const heroSubtitle = 'Ranked by total IPv4 address space across each organization.';
    const pageLinks = buildPageLinks('/top-organizations-by-ip-address');

    let errorMessage = null;
    let entries = [];

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        entries = asnInfoStore.getTopOrganizationsByIpv4(25).map((entry) => {
            const topAsns = entry.organization
                ? asnInfoStore.getAsnsForOrg(entry.organization, 3).map((asnEntry) => ({
                    ...asnEntry,
                    ipv4AmountDisplay: formatIpv4Amount(asnEntry.ipv4Amount),
                }))
                : [];
            const topAsnSummary = topAsns.length
                ? topAsns
                    .map((asnEntry) => `AS${asnEntry.asn}: ${asnEntry.ipv4AmountDisplay}`)
                    .join(' | ')
                : null;
            const orgSlug = entry.organization ? buildOrgSlug(entry.organization) : null;
            return {
                ...entry,
                displayOrganization: entry.organization || 'Unknown org',
                orgSlug,
                ipv4AmountDisplay: formatIpv4Amount(entry.ipv4Amount),
                topAsns,
                topAsnSummary,
            };
        });
    }

    res.render('asn-org-top', {
        pageTitle,
        pageDescription,
        heroTitle,
        heroSubtitle,
        entries,
        errorMessage,
        pageLinks,
        generatedAt,
        generationTimeMs,
    });
};

export const registerAsnTopRoutes = (app, helpers = {}) => {
    if (!app || typeof app.get !== 'function') {
        throw new TypeError('registerAsnTopRoutes requires an express app instance');
    }

    const asnInfoStore = requireAsnStore(helpers.asnInfoStore);
    const getRenderMeta = requireHelper(helpers.getRenderMeta, 'getRenderMeta');
    const getCountrySlugIndex = createCountrySlugIndex(asnInfoStore);

    app.get('/top-asn-by-ip-address', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv4'}));
    app.get('/top-asn-by-ipv6', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv6'}));
    app.get('/top-organizations-by-ip-address', createTopOrgHandler({asnInfoStore, getRenderMeta}));
    app.get('/list-of-countries-by-ipv4-allocation', createTopCountryHandler({asnInfoStore, getRenderMeta}));
    app.get('/top-countries-by-ip-address', (req, res) => {
        res.redirect(301, '/list-of-countries-by-ipv4-allocation');
    });
    app.get(/^\/([a-z0-9-]+)-asn-list$/i, createCountryAsnListHandler({asnInfoStore, getRenderMeta, getCountrySlugIndex}));
};
