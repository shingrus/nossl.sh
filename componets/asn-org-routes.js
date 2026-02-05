import {normalizeOrgSlug} from './org-slug.js';
import {formatIpv4Amount} from './asn-format.js';
import {extractPrefixes} from './asn-prefixes.js';
import {setNoCacheHeaders} from './cache-headers.js';

const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerAsnOrgRoutes expected a function for ${name}`);
    }
    return value;
};

const requireAsnStore = (value) => {
    if (
        !value ||
        typeof value.isAvailable !== 'function' ||
        typeof value.getOrgSummaryBySlug !== 'function' ||
        typeof value.getAsnsByOrgSlug !== 'function'
    ) {
        throw new TypeError('registerAsnOrgRoutes requires an ASN info store with org helpers');
    }
    return value;
};

const buildOrgPageTitle = (orgName, slug) => {
    if (orgName) {
        return `${orgName} ASNs`;
    }
    return slug ? `Organization ${slug} ASNs` : 'Organization ASNs';
};

const buildOrgPageDescription = (orgName, ipv4Prefixes, ipv6Prefixes, domain) => {
    let description = orgName ? `ASNs for ${orgName}` : 'ASNs for this organization';
    if (domain) {
        description += ` (${domain})`;
    }
    description += `. Prefix totals: IPv4 ${ipv4Prefixes}, IPv6 ${ipv6Prefixes}.`;
    return description;
};

const createOrgPageHandler = ({asnInfoStore, getRenderMeta, canonicalBaseUrl}) => (req, res) => {
    const {generatedAt, generationTimeMs} = getRenderMeta(res);
    setNoCacheHeaders(res, {includeLegacy: true});

    const orgParam = req.params.orgSlug;
    const orgSlug = normalizeOrgSlug(orgParam);
    const canonicalUrl = orgSlug ? new URL(`/asn-${orgSlug}`, canonicalBaseUrl).toString() : null;
    if (!orgSlug) {
        res.status(400);
        res.render('asn-org', {
            orgName: null,
            orgSlug: orgParam,
            domain: null,
            ipv4Amount: null,
            ipv4AmountDisplay: 'N/A',
            ipv4PrefixTotal: 0,
            ipv6PrefixTotal: 0,
            asnCount: 0,
            entries: [],
            pageTitle: 'Organization lookup error',
            pageDescription: 'Invalid organization slug.',
            errorMessage: 'Invalid organization value.',
            canonicalUrl,
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    if (!asnInfoStore.isAvailable()) {
        res.status(503);
        res.render('asn-org', {
            orgName: null,
            orgSlug,
            domain: null,
            ipv4Amount: null,
            ipv4AmountDisplay: 'N/A',
            ipv4PrefixTotal: 0,
            ipv6PrefixTotal: 0,
            asnCount: 0,
            entries: [],
            pageTitle: buildOrgPageTitle(null, orgSlug),
            pageDescription: 'Organization details are unavailable because the ASN database is not configured.',
            errorMessage: 'ASN database is not configured.',
            canonicalUrl,
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    const orgSummary = asnInfoStore.getOrgSummaryBySlug(orgSlug);
    if (!orgSummary) {
        res.status(404);
        res.render('asn-org', {
            orgName: null,
            orgSlug,
            domain: null,
            ipv4Amount: null,
            ipv4AmountDisplay: 'N/A',
            ipv4PrefixTotal: 0,
            ipv6PrefixTotal: 0,
            asnCount: 0,
            entries: [],
            pageTitle: buildOrgPageTitle(null, orgSlug),
            pageDescription: `No ASN organization record found for ${orgSlug}.`,
            errorMessage: `Organization ${orgSlug} not found.`,
            canonicalUrl,
            generatedAt,
            generationTimeMs,
        });
        return;
    }

    const rows = asnInfoStore.getAsnsByOrgSlug(orgSlug);
    let ipv4PrefixTotal = 0;
    let ipv6PrefixTotal = 0;
    const entries = rows.map((row) => {
        const hasData = row.data && !row.parseError;
        const ipv4PrefixCount = hasData ? extractPrefixes(row.data, 'ipv4').length : null;
        const ipv6PrefixCount = hasData ? extractPrefixes(row.data, 'ipv6').length : null;
        if (typeof ipv4PrefixCount === 'number') {
            ipv4PrefixTotal += ipv4PrefixCount;
        }
        if (typeof ipv6PrefixCount === 'number') {
            ipv6PrefixTotal += ipv6PrefixCount;
        }
        return {
            asn: row.asn,
            handle: row.handle,
            ipv4PrefixCount,
            ipv6PrefixCount,
        };
    });

    const orgName = orgSummary.organization || rows.find((row) => row.organization)?.organization || null;
    const pageTitle = buildOrgPageTitle(orgName, orgSlug);
    const pageDescription = buildOrgPageDescription(
        orgName,
        ipv4PrefixTotal,
        ipv6PrefixTotal,
        orgSummary.domain,
    );

    res.render('asn-org', {
        orgName,
        orgSlug,
        domain: orgSummary.domain,
        ipv4Amount: orgSummary.ipv4Amount ?? null,
        ipv4AmountDisplay: formatIpv4Amount(orgSummary.ipv4Amount),
        ipv4PrefixTotal,
        ipv6PrefixTotal,
        asnCount: orgSummary.asnCount,
        entries,
        pageTitle,
        pageDescription,
        errorMessage: null,
        canonicalUrl,
        generatedAt,
        generationTimeMs,
    });
};

export const registerAsnOrgRoutes = (app, helpers = {}) => {
    if (!app || typeof app.get !== 'function') {
        throw new TypeError('registerAsnOrgRoutes requires an express app instance');
    }

    const asnInfoStore = requireAsnStore(helpers.asnInfoStore);
    const getRenderMeta = requireHelper(helpers.getRenderMeta, 'getRenderMeta');
    const canonicalBaseUrl = helpers.canonicalBaseUrl;

    app.get('/asn-:orgSlug', createOrgPageHandler({asnInfoStore, getRenderMeta, canonicalBaseUrl}));
};
