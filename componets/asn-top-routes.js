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
        typeof value.getAsnsForOrg !== 'function' ||
        typeof value.getRelatedAsnsByOrg !== 'function'
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

const formatIpv4Amount = (value) => {
    const digits = parseDigits(value);
    if (!digits) {
        return value == null ? 'N/A' : String(value);
    }
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

const formatIpv6Amount = (value) => {
    const digits = parseDigits(value);
    if (!digits) {
        return value == null ? 'N/A' : String(value);
    }
    const amount = BigInt(digits);
    const million = 1000000n;
    const whole = amount / million;
    const remainder = amount % million;
    let rounded = (remainder + 5000n) / 10000n;
    let wholeAdjusted = whole;
    if (rounded >= 100n) {
        wholeAdjusted = whole + 1n;
        rounded = 0n;
    }
    const decimal = rounded.toString().padStart(2, '0');
    const wholeFormatted = formatIpv4Amount(wholeAdjusted.toString());
    return `${wholeFormatted}.${decimal} mln`;
};

const createTopAsnHandler = ({asnInfoStore, getRenderMeta, family}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    const isIpv4 = family === 'ipv4';
    const pageTitle = isIpv4 ? 'Top ASNs by IPv4 address space' : 'Top ASNs by IPv6 address space';
    const pageDescription = isIpv4
        ? 'Top 10 ASNs ranked by IPv4 address space, with organization details and related ASNs.'
        : 'Top 10 ASNs ranked by IPv6 address space, with organization details and related ASNs.';
    const heroTitle = pageTitle;
    const heroSubtitle = isIpv4
        ? 'Ranked by total announced IPv4 address space. Related ASNs are grouped by organization.'
        : 'Ranked by total announced IPv6 address space. Related ASNs are grouped by organization.';
    const showSecondaryAmount = !isIpv4;
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
            ? asnInfoStore.getTopAsnsByIpv4(10)
            : asnInfoStore.getTopAsnsByIpv6(10);
        entries = rows.map((entry) => {
            const relatedAsns = entry.organization
                ? asnInfoStore.getRelatedAsnsByOrg(entry.organization, entry.asn, 3)
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
        entries = asnInfoStore.getTopOrganizationsByIpv4(10).map((entry) => {
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
            return {
                ...entry,
                displayOrganization: entry.organization || 'Unknown org',
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

    app.get('/top-asn-by-ip-address', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv4'}));
    app.get('/top-asn-by-ipv6', createTopAsnHandler({asnInfoStore, getRenderMeta, family: 'ipv6'}));
    app.get('/top-organizations-by-ip-address', createTopOrgHandler({asnInfoStore, getRenderMeta}));
};
