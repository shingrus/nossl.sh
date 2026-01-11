const normalizePrefix = (entry) => {
    if (typeof entry === 'string') {
        return entry;
    }
    if (entry && typeof entry === 'object') {
        for (const key of ['prefix', 'cidr', 'network', 'subnet']) {
            if (typeof entry[key] === 'string') {
                return entry[key];
            }
        }
    }
    return null;
};

export const extractPrefixes = (asnData, family) => {
    if (!asnData || typeof asnData !== 'object') {
        return [];
    }
    for (const containerKey of ['prefixes', 'subnets']) {
        const container = asnData[containerKey];
        if (container && typeof container === 'object') {
            const prefixes = container[family];
            if (Array.isArray(prefixes)) {
                return prefixes.map(normalizePrefix).filter(Boolean);
            }
        }
    }
    const topLevel = asnData[family];
    if (Array.isArray(topLevel)) {
        return topLevel.map(normalizePrefix).filter(Boolean);
    }
    return [];
};
