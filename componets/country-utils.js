const regionDisplayNames = (() => {
    try {
        if (typeof Intl?.DisplayNames === 'function') {
            return new Intl.DisplayNames(['en'], {type: 'region'});
        }
    } catch (error) {
        // ignore
    }
    return null;
})();

export const normalizeCountryCode = (value) => {
    if (!value || typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) {
        return null;
    }
    return normalized;
};

export const normalizeCountrySlug = (value) => {
    if (!value || typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized || !/^[a-z0-9-]+$/.test(normalized)) {
        return null;
    }
    const cleaned = normalized.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || null;
};

export const buildCountrySlug = (value) => {
    if (!value || typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    const ascii = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const cleaned = ascii.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return cleaned || null;
};

export const countryCodeToFlag = (countryCode) => {
    const code = normalizeCountryCode(countryCode);
    if (!code) {
        return null;
    }
    const offset = 127397;
    return Array.from(code).map((letter) => String.fromCodePoint(letter.charCodeAt(0) + offset)).join('');
};

export const countryCodeToName = (countryCode) => {
    const code = normalizeCountryCode(countryCode);
    if (!code) {
        return null;
    }
    if (!regionDisplayNames) {
        return null;
    }
    try {
        return regionDisplayNames.of(code) || null;
    } catch (error) {
        return null;
    }
};
