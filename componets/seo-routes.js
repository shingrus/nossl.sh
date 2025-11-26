import {SEO_PAGES} from './seo-pages.js';

const CANONICAL_BASE_URL = 'https://nossl.sh';

const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerSeoRoutes expected a function for ${name}`);
    }
    return value;
};

const createSeoPageRenderer =
    ({getBaseRequestData, buildShareLinkForRequest}) =>
        (page) =>
            async (req, res) => {
                const canonicalUrl = new URL(page.path, CANONICAL_BASE_URL);
                const baseData = getBaseRequestData(req, res) || {};
                const counters = baseData.counters || {};
                const totalRequests = baseData.totalRequests ?? 0;
                const seoCounter = counters.seoLandingCount ?? 0;

                let shareReportId = null;
                let shareReportUrl = null;

                if (typeof buildShareLinkForRequest === 'function') {
                    const shareData = await buildShareLinkForRequest(req, baseData);
                    shareReportId = shareData?.shareReportId ?? null;
                    shareReportUrl = shareData?.shareReportUrl ?? null;
                }

                res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
                res.set('Pragma', 'no-cache');
                res.set('Expires', '0');

                res.render('seo-page', {
                    ...baseData,
                    page,
                    totalRequests,
                    seoCounter,
                    canonicalUrl: canonicalUrl.toString(),
                    shareReportEnabled: Boolean(shareReportUrl),
                    shareReportId,
                    shareReportUrl,
                });
            };

export const registerSeoRoutes = (app, helpers = {}) => {
    if (!app || typeof app.get !== 'function') {
        throw new TypeError('registerSeoRoutes requires an express app instance');
    }

    const getBaseRequestData = requireHelper(helpers.getBaseRequestData, 'getBaseRequestData');
    const renderSeoPage = createSeoPageRenderer({
        getBaseRequestData,
        buildShareLinkForRequest: helpers.buildShareLinkForRequest,
    });

    SEO_PAGES.forEach((page) => {
        app.get(page.path, renderSeoPage(page));
    });
};
