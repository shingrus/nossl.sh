import {SEO_PAGES} from './seo-pages.js';

const CANONICAL_BASE_URL = 'https://nossl.sh';

const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerSeoRoutes expected a function for ${name}`);
    }
    return value;
};

const createSeoPageRenderer = ({getScheme, getCountersSnapshot}) => (page) => (req, res) => {
    const scheme = getScheme(req);
    const counters = getCountersSnapshot();
    const totalRequests = counters.httpCount + counters.httpsCount;
    const generatedAt = new Date();
    const canonicalUrl = new URL(page.path, CANONICAL_BASE_URL);

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    res.render('seo-page', {
        page,
        scheme,
        counters,
        totalRequests,
        generatedAt,
        seoCounter: counters.seoLandingCount,
        canonicalUrl: canonicalUrl.toString(),
    });
};

export const registerSeoRoutes = (app, helpers = {}) => {
    if (!app || typeof app.get !== 'function') {
        throw new TypeError('registerSeoRoutes requires an express app instance');
    }

    const getScheme = requireHelper(helpers.getScheme, 'getScheme');
    const getCountersSnapshot = requireHelper(helpers.getCountersSnapshot, 'getCountersSnapshot');
    const renderSeoPage = createSeoPageRenderer({getScheme, getCountersSnapshot});

    SEO_PAGES.forEach((page) => {
        app.get(page.path, renderSeoPage(page));
    });
};
