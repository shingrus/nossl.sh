import {SEO_PAGES} from './seo-pages.js';
import {setNoCacheHeaders} from './cache-headers.js';

const requireHelper = (value, name) => {
    if (typeof value !== 'function') {
        throw new TypeError(`registerSeoRoutes expected a function for ${name}`);
    }
    return value;
};

const createSeoPageRenderer =
    ({getBaseRequestData, buildShareLinkForRequest, canonicalBaseUrl}) =>
        (page) =>
            async (req, res) => {
                const canonicalUrl = new URL(page.path, canonicalBaseUrl);
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

                setNoCacheHeaders(res, {includeLegacy: true});

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
    const canonicalBaseUrl = helpers.canonicalBaseUrl;
    const renderSeoPage = createSeoPageRenderer({
        getBaseRequestData,
        buildShareLinkForRequest: helpers.buildShareLinkForRequest,
        canonicalBaseUrl,
    });

    SEO_PAGES.forEach((page) => {
        app.get(page.path, renderSeoPage(page));
    });
};
