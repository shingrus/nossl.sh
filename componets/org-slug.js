export const buildOrgSlug = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return null;
    }
    const cleaned = trimmed.replace(/[^a-z0-9 ]+/g, '');
    const collapsed = cleaned.replace(/\s+/g, ' ').trim();
    if (!collapsed) {
        return null;
    }
    return collapsed.replace(/ /g, '-');
};

export const normalizeOrgSlug = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return null;
    }
    const cleaned = trimmed.replace(/[^a-z0-9\- ]+/g, '');
    const withHyphens = cleaned.replace(/\s+/g, '-');
    const normalized = withHyphens.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return normalized || null;
};
