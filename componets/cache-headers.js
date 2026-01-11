export const NO_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, max-age=0, private';

export const setNoCacheHeaders = (res, {includeLegacy = false} = {}) => {
    if (!res || typeof res.set !== 'function') {
        return;
    }
    res.set('Cache-Control', NO_CACHE_CONTROL);
    if (includeLegacy) {
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
};
