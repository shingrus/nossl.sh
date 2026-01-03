import Database from 'better-sqlite3';

const parseAsnNumber = (value) => {
    const raw = typeof value === 'string' ? value.trim() : String(value || '').trim();
    if (!/^\d+$/.test(raw)) {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return null;
    }
    return parsed;
};

const parseAsnJson = (jsonText) => {
    if (typeof jsonText !== 'string') {
        return {data: null, rawJson: null, parseError: true};
    }
    try {
        const parsed = JSON.parse(jsonText);
        return {data: parsed, rawJson: null, parseError: false};
    } catch (error) {
        return {data: null, rawJson: jsonText, parseError: true};
    }
};

const createEmptyStore = () => ({
    isAvailable: () => false,
    parseAsnNumber,
    getAsnInfo: () => null,
});

export const createAsnInfoStore = (dbPath) => {
    if (!dbPath) {
        return createEmptyStore();
    }
    try {
        const db = new Database(dbPath, {readonly: true, fileMustExist: true});
        const selectAsnInfoStmt = db.prepare(
            'SELECT json, CAST(ipv4_amount AS TEXT) AS ipv4_amount FROM asn WHERE asn = ?'
        );
        const selectAsnDomainStmt = db.prepare('SELECT domain FROM asn_domain WHERE asn = ?');

        const getAsnInfo = (asnNumber) => {
            const parsed = parseAsnNumber(asnNumber);
            if (!parsed) {
                return null;
            }
            try {
                const row = selectAsnInfoStmt.get(parsed);
                if (!row) {
                    return null;
                }
                const domainRow = selectAsnDomainStmt.get(parsed);
                const {data, rawJson, parseError} = parseAsnJson(row.json);
                return {
                    asn: parsed,
                    domain: domainRow?.domain || null,
                    data,
                    rawJson,
                    parseError,
                    ipv4Amount: row.ipv4_amount ?? null,
                };
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query ASN info', error);
                return null;
            }
        };

        return {
            isAvailable: () => true,
            parseAsnNumber,
            getAsnInfo,
        };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load ASN info database', error);
        return createEmptyStore();
    }
};
