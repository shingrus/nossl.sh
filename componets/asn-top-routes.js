import {buildOrgSlug} from './org-slug.js';

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
        typeof value.getTopAsnsByIpv4Count !== 'function' ||
        typeof value.getTopAsnsByIpv6 !== 'function' ||
        typeof value.getTopAsnsByIpv6Count !== 'function' ||
        typeof value.getTopOrganizationsByIpv4 !== 'function' ||
        typeof value.getTopOrganizationsByIpv4Count !== 'function' ||
        typeof value.getAsnsForOrg !== 'function'
    ) {
        throw new TypeError('registerAsnTopRoutes requires an ASN info store with ranking helpers');
    }
    return value;
};

const RANKING_PAGES = Object.freeze([
    {path: '/top-asn-by-ip-address', label: 'Top ASNs by IPv4'},
    {path: '/top-asn-by-ipv6', label: 'Top ASNs by IPv6'},
    {path: '/top-organizations-by-ip-address', label: 'Top orgs by IPv4'},
]);

const buildPageLinks = (activePath) =>
    RANKING_PAGES.map((page) => ({
        ...page,
        active: page.path === activePath,
    }));

const parseDigits = (value) => {
    const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!raw || !/^\d+$/.test(raw)) {
        return null;
    }
    return raw;
};

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

const PAGE_SIZE = 250;

const parsePage = (value) => {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 1;
    }
    return parsed;
};

const buildPagePath = (basePath, page) => (page <= 1 ? basePath : `${basePath}?page=${page}`);

const buildPagination = ({currentPage, totalPages, basePath}) => {
    const safeTotalPages = Math.max(1, totalPages);
    const safeCurrent = Math.min(Math.max(currentPage, 1), safeTotalPages);
    const maxLinks = 7;
    let start = Math.max(1, safeCurrent - Math.floor(maxLinks / 2));
    let end = Math.min(safeTotalPages, start + maxLinks - 1);
    if (end - start + 1 < maxLinks) {
        start = Math.max(1, end - maxLinks + 1);
    }

    const pages = [];
    const pushPage = (page) => {
        pages.push({
            label: String(page),
            path: buildPagePath(basePath, page),
            active: page === safeCurrent,
            isEllipsis: false,
        });
    };
    if (start > 1) {
        pushPage(1);
        if (start > 2) {
            pages.push({label: '…', path: null, active: false, isEllipsis: true});
        }
    }
    for (let page = start; page <= end; page += 1) {
        pushPage(page);
    }
    if (end < safeTotalPages) {
        if (end < safeTotalPages - 1) {
            pages.push({label: '…', path: null, active: false, isEllipsis: true});
        }
        pushPage(safeTotalPages);
    }

    return {
        currentPage: safeCurrent,
        totalPages: safeTotalPages,
        pages,
        prevPath: safeCurrent > 1 ? buildPagePath(basePath, safeCurrent - 1) : null,
        nextPath: safeCurrent < safeTotalPages ? buildPagePath(basePath, safeCurrent + 1) : null,
    };
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

const formatIpv4Amount = (value) => {
    const digits = parseDigits(value);
    if (!digits) {
        return value == null ? 'N/A' : String(value);
    }
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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

const createTopAsnHandler = ({asnInfoStore, getRenderMeta, family}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const isIpv4 = family === 'ipv4';
    const pageTitle = isIpv4 ? 'Top ASNs by IPv4 address space' : 'Top ASNs by IPv6 address space';
    const pageDescription = isIpv4
        ? 'Top ASNs ranked by IPv4 address space, with organization details and related ASNs.'
        : 'Top ASNs ranked by IPv6 address space, with organization details and related ASNs.';
    const heroTitle = pageTitle;
    const heroSubtitle = isIpv4
        ? 'Ranked by total announced IPv4 address space. Related ASNs are grouped by organization.'
        : 'Ranked by total announced IPv6 address space. Related ASNs are grouped by organization.';
    const showSecondaryAmount = false;
    const ipv4Label = 'IPv4 addresses';
    const ipv6Label = 'IPv6 addresses (mln)';
    const primaryAmountLabel = isIpv4 ? ipv4Label : ipv6Label;
    const secondaryAmountLabel = isIpv4 ? ipv6Label : ipv4Label;
    const basePath = isIpv4 ? '/top-asn-by-ip-address' : '/top-asn-by-ipv6';
    const pageLinks = buildPageLinks(basePath);
    const requestedPage = parsePage(req.query.page);

    let errorMessage = null;
    let entries = [];
    let pagination = null;
    let offset = 0;
    let totalEntries = 0;

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        totalEntries = isIpv4
            ? asnInfoStore.getTopAsnsByIpv4Count()
            : asnInfoStore.getTopAsnsByIpv6Count();
        const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
        const currentPage = Math.min(requestedPage, totalPages);
        offset = (currentPage - 1) * PAGE_SIZE;
        pagination = buildPagination({currentPage, totalPages, basePath});
        const rows = isIpv4
            ? asnInfoStore.getTopAsnsByIpv4(PAGE_SIZE, offset)
            : asnInfoStore.getTopAsnsByIpv6(PAGE_SIZE, offset);
        entries = rows.map((entry) => {
            const relatedAsns = entry.organization
                ? asnInfoStore.getAsnsForOrg(entry.organization, 3, entry.asn)
                : [];
            return {
                ...entry,
                displayOrganization: entry.organization || 'Unknown org',
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
        pagination,
        pageSize: PAGE_SIZE,
        offset,
        totalEntries,
        generatedAt,
        generationTimeMs,
    });
};

const createTopOrgHandler = ({asnInfoStore, getRenderMeta}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const pageTitle = 'Top organizations by IPv4 address space';
    const pageDescription = 'Top organizations ranked by IPv4 address space, with related ASNs.';
    const heroTitle = pageTitle;
    const heroSubtitle = 'Ranked by total IPv4 address space across each organization.';
    const basePath = '/top-organizations-by-ip-address';
    const pageLinks = buildPageLinks(basePath);
    const requestedPage = parsePage(req.query.page);

    let errorMessage = null;
    let entries = [];
    let pagination = null;
    let offset = 0;
    let totalEntries = 0;

    if (!asnInfoStore.isAvailable()) {
        errorMessage = 'ASN database is not configured.';
        res.status(503);
    } else {
        totalEntries = asnInfoStore.getTopOrganizationsByIpv4Count();
        const totalPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));
        const currentPage = Math.min(requestedPage, totalPages);
        offset = (currentPage - 1) * PAGE_SIZE;
        pagination = buildPagination({currentPage, totalPages, basePath});
        entries = asnInfoStore.getTopOrganizationsByIpv4(PAGE_SIZE, offset).map((entry) => {
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
        pagination,
        pageSize: PAGE_SIZE,
        offset,
        totalEntries,
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

    app.get('/top-asn-by-ip-address', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv4'}));
    app.get('/top-asn-by-ipv6', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv6'}));
    app.get('/top-organizations-by-ip-address', createTopOrgHandler({asnInfoStore, getRenderMeta}));
};
