import fs from 'fs';
import Database from 'better-sqlite3';
import {normalizeOrgSlug} from './org-slug.js';

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

const normalizeText = (value) => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
};

const normalizeLimit = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
};

const buildAmountSumSql = (column, castType) =>
    `SUM(CASE WHEN ${column} IS NULL OR CAST(${column} AS TEXT) = '' THEN 0 ELSE CAST(${column} AS ${castType}) END)`;

const IPV4_AMOUNT_SUM_SQL = buildAmountSumSql('a.ipv4_amount', 'INTEGER');
const IPV4_AMOUNT_SUM_TEXT_SQL = `CAST(${IPV4_AMOUNT_SUM_SQL} AS TEXT)`;
const IPV6_AMOUNT_SUM_SQL = buildAmountSumSql('a.ipv6_amount', 'REAL');
const IPV6_AMOUNT_SUM_REAL_SQL = `CAST(${IPV6_AMOUNT_SUM_SQL} AS REAL)`;
const IPV4_AMOUNT_SORT_TEXT_SQL = "COALESCE(CAST(a.ipv4_amount AS TEXT), '0')";
const ASN_SELECT_COLUMNS = `
            a.asn,
            a.handle,
            NULLIF(TRIM(a.organization), '') AS organization,
            CAST(a.ipv4_amount AS TEXT) AS ipv4_amount,
            CAST(a.ipv6_amount AS REAL) AS ipv6_amount,
            d.domain AS domain
        `;
const ASN_SELECT_COLUMNS_WITH_JSON = `${ASN_SELECT_COLUMNS},
            a.json AS json`;

const createEmptyStore = () => ({
    isAvailable: () => false,
    parseAsnNumber,
    getAsnInfo: () => null,
    getTopAsnsByIpv4: () => [],
    getTopAsnsByIpv6: () => [],
    getTopOrganizationsByIpv4: () => [],
    getTopCountriesByIpv4: () => null,
    getAsnsByCountry: () => null,
    getCountryAsnCount: () => null,
    getCountryList: () => [],
    getAsnsForOrg: () => [],
    getOrgSummaryBySlug: () => null,
    getAsnsByOrgSlug: () => [],
    findOrgByPrefix: () => null,
});

const getDbMtime = (dbPath) => {
    if (!dbPath) {
        return null;
    }
    try {
        const stats = fs.statSync(dbPath);
        return stats?.mtime instanceof Date ? stats.mtime : null;
    } catch (error) {
        return null;
    }
};

const createAsnInfoStoreInstance = (dbPath) => {
    if (!dbPath) {
        return {
            store: createEmptyStore(),
            close: () => {},
        };
    }
    let db = null;
    try {
        db = new Database(dbPath, {readonly: true, fileMustExist: true});
        const selectAsnInfoStmt = db.prepare(`
            SELECT json,
                   CAST(ipv4_amount AS TEXT) AS ipv4_amount,
                   CAST(ipv6_amount AS REAL) AS ipv6_amount
              FROM asn
             WHERE asn = ?
        `);
        const selectAsnDomainStmt = db.prepare('SELECT domain FROM asn_domain WHERE asn = ?');
        const asnColumns = db.prepare("PRAGMA table_info(asn)").all();
        const hasOrgSlugColumn = asnColumns.some((column) => column.name === 'organization_slug');
        const hasCountryColumn = asnColumns.some((column) => column.name === 'country');
        const selectTopAsnsByIpv4Stmt = db.prepare(`
            SELECT ${ASN_SELECT_COLUMNS}
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE a.ipv4_amount IS NOT NULL
               AND CAST(a.ipv4_amount AS TEXT) != ''
               AND CAST(a.ipv4_amount AS TEXT) != '0'
             ORDER BY LENGTH(CAST(a.ipv4_amount AS TEXT)) DESC,
                      CAST(a.ipv4_amount AS TEXT) DESC
             LIMIT ?
        `);
        const selectTopAsnsByIpv6Stmt = db.prepare(`
            SELECT ${ASN_SELECT_COLUMNS}
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE a.ipv6_amount IS NOT NULL
               AND CAST(a.ipv6_amount AS REAL) > 0
             ORDER BY CAST(a.ipv6_amount AS REAL) DESC
             LIMIT ?
        `);
        const selectTopOrganizationsByIpv4Stmt = db.prepare(`
            SELECT NULLIF(TRIM(a.organization), '') AS organization,
                   ${IPV4_AMOUNT_SUM_TEXT_SQL} AS ipv4_amount,
                   COUNT(*) AS asn_count
              FROM asn a
             WHERE a.organization IS NOT NULL
               AND TRIM(a.organization) != ''
             GROUP BY TRIM(a.organization)
            HAVING ${IPV4_AMOUNT_SUM_SQL} > 0
             ORDER BY LENGTH(${IPV4_AMOUNT_SUM_TEXT_SQL}) DESC,
                      ${IPV4_AMOUNT_SUM_SQL} DESC
             LIMIT ?
        `);
        const selectAsnsByOrgStmt = db.prepare(`
            SELECT ${ASN_SELECT_COLUMNS}
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE TRIM(a.organization) = ?
               AND (? IS NULL OR a.asn != ?)
             ORDER BY LENGTH(${IPV4_AMOUNT_SORT_TEXT_SQL}) DESC,
                      ${IPV4_AMOUNT_SORT_TEXT_SQL} DESC
             LIMIT ?
        `);
        const selectTopCountriesByIpv4Stmt = hasCountryColumn
            ? db.prepare(`
                SELECT TRIM(a.country) AS country,
                       ${IPV4_AMOUNT_SUM_TEXT_SQL} AS ipv4_amount,
                       COUNT(*) AS asn_count
                  FROM asn a
                 WHERE a.country IS NOT NULL
                   AND TRIM(a.country) != ''
                 GROUP BY TRIM(a.country)
                HAVING ${IPV4_AMOUNT_SUM_SQL} > 0
                 ORDER BY LENGTH(${IPV4_AMOUNT_SUM_TEXT_SQL}) DESC,
                          ${IPV4_AMOUNT_SUM_SQL} DESC,
                          TRIM(a.country) ASC
                 LIMIT ?
            `)
            : null;
        const selectAsnsByCountryStmt = hasCountryColumn
            ? db.prepare(`
                SELECT ${ASN_SELECT_COLUMNS}
                  FROM asn a
                  LEFT JOIN asn_domain d ON a.asn = d.asn
                 WHERE TRIM(a.country) = ?
                 ORDER BY LENGTH(${IPV4_AMOUNT_SORT_TEXT_SQL}) DESC,
                          ${IPV4_AMOUNT_SORT_TEXT_SQL} DESC,
                          a.asn ASC
                 LIMIT ? OFFSET ?
            `)
            : null;
        const selectCountryAsnCountStmt = hasCountryColumn
            ? db.prepare(`
                SELECT COUNT(*) AS asn_count
                  FROM asn a
                 WHERE TRIM(a.country) = ?
            `)
            : null;
        const selectCountryListStmt = hasCountryColumn
            ? db.prepare(`
                SELECT DISTINCT TRIM(a.country) AS country
                  FROM asn a
                 WHERE a.country IS NOT NULL
                   AND TRIM(a.country) != ''
                 ORDER BY TRIM(a.country) ASC
            `)
            : null;
        const selectOrgSummaryBySlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT ${IPV4_AMOUNT_SUM_TEXT_SQL} AS ipv4_amount,
                       ${IPV6_AMOUNT_SUM_REAL_SQL} AS ipv6_amount,
                       COUNT(*) AS asn_count
                  FROM asn a
                 WHERE a.organization_slug = ?
            `)
            : null;
        const selectOrgNameBySlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT NULLIF(TRIM(a.organization), '') AS organization
                  FROM asn a
                 WHERE a.organization_slug = ?
                   AND a.organization IS NOT NULL
                   AND TRIM(a.organization) != ''
                 ORDER BY LENGTH(TRIM(a.organization)) DESC, TRIM(a.organization)
                 LIMIT 1
            `)
            : null;
        const selectOrgDomainBySlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT d.domain AS domain
                  FROM asn a
                  JOIN asn_domain d ON a.asn = d.asn
                 WHERE a.organization_slug = ?
                   AND d.domain IS NOT NULL
                   AND TRIM(d.domain) != ''
                 ORDER BY a.asn
                 LIMIT 1
            `)
            : null;
        const selectOrgByPrefixStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT a.organization_slug AS slug,
                       NULLIF(TRIM(a.organization), '') AS organization,
                       ${IPV4_AMOUNT_SUM_TEXT_SQL} AS ipv4_amount,
                       ${IPV6_AMOUNT_SUM_REAL_SQL} AS ipv6_amount,
                       COUNT(*) AS asn_count
                  FROM asn a
                 WHERE a.organization IS NOT NULL
                   AND TRIM(a.organization) != ''
                   AND a.organization_slug IS NOT NULL
                   AND TRIM(a.organization_slug) != ''
                   AND LOWER(TRIM(a.organization)) LIKE LOWER(?)
                 GROUP BY a.organization_slug, TRIM(a.organization)
                HAVING ${IPV4_AMOUNT_SUM_SQL} > 0
                    OR ${IPV6_AMOUNT_SUM_SQL} > 0
                 ORDER BY LENGTH(${IPV4_AMOUNT_SUM_TEXT_SQL}) DESC,
                          ${IPV4_AMOUNT_SUM_SQL} DESC,
                          ${IPV6_AMOUNT_SUM_SQL} DESC,
                          a.organization_slug ASC
                 LIMIT 1
            `)
            : null;
        const selectAsnsByOrgSlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT ${ASN_SELECT_COLUMNS_WITH_JSON}
                  FROM asn a
                  LEFT JOIN asn_domain d ON a.asn = d.asn
                 WHERE a.organization_slug = ?
                 ORDER BY a.asn ASC
            `)
            : null;

        const normalizeAsnRow = (row) => {
            if (!row) {
                return null;
            }
            return {
                asn: row.asn,
                handle: normalizeText(row.handle),
                organization: normalizeText(row.organization),
                ipv4Amount: row.ipv4_amount ?? null,
                ipv6Amount: row.ipv6_amount ?? null,
                domain: normalizeText(row.domain),
            };
        };

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
                    ipv6Amount: row.ipv6_amount ?? null,
                };
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query ASN info', error);
                return null;
            }
        };

        const getTopAsnsByIpv4 = (limit = 25) => {
            const safeLimit = normalizeLimit(limit, 25);
            try {
                return selectTopAsnsByIpv4Stmt.all(safeLimit).map(normalizeAsnRow).filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv4 ASNs', error);
                return [];
            }
        };

        const getTopAsnsByIpv6 = (limit = 25) => {
            const safeLimit = normalizeLimit(limit, 25);
            try {
                return selectTopAsnsByIpv6Stmt.all(safeLimit).map(normalizeAsnRow).filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv6 ASNs', error);
                return [];
            }
        };

        const getTopOrganizationsByIpv4 = (limit = 25) => {
            const safeLimit = normalizeLimit(limit, 25);
            try {
                return selectTopOrganizationsByIpv4Stmt.all(safeLimit).map((row) => {
                    const asnCount = Number.isFinite(row.asn_count)
                        ? row.asn_count
                        : Number.parseInt(row.asn_count, 25);
                    return {
                        organization: normalizeText(row.organization),
                        ipv4Amount: row.ipv4_amount ?? null,
                        asnCount: Number.isFinite(asnCount) ? asnCount : 0,
                    };
                });
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top organizations', error);
                return [];
            }
        };

        const getTopCountriesByIpv4 = (limit = 25) => {
            if (!selectTopCountriesByIpv4Stmt) {
                return null;
            }
            const safeLimit = normalizeLimit(limit, 25);
            try {
                return selectTopCountriesByIpv4Stmt.all(safeLimit).map((row) => {
                    const asnCount = Number.isFinite(row.asn_count)
                        ? row.asn_count
                        : Number.parseInt(row.asn_count, 10);
                    return {
                        country: normalizeText(row.country),
                        ipv4Amount: row.ipv4_amount ?? null,
                        asnCount: Number.isFinite(asnCount) ? asnCount : 0,
                    };
                });
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top countries', error);
                return [];
            }
        };

        const getAsnsByCountry = (countryCode, limit = 1000, offset = 0) => {
            if (!selectAsnsByCountryStmt) {
                return null;
            }
            const normalized = normalizeText(countryCode);
            if (!normalized) {
                return [];
            }
            const safeLimit = normalizeLimit(limit, 1000);
            const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
            try {
                return selectAsnsByCountryStmt
                    .all(normalized, safeLimit, safeOffset)
                    .map(normalizeAsnRow)
                    .filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query ASNs by country', error);
                return [];
            }
        };

        const getCountryAsnCount = (countryCode) => {
            if (!selectCountryAsnCountStmt) {
                return null;
            }
            const normalized = normalizeText(countryCode);
            if (!normalized) {
                return 0;
            }
            try {
                const row = selectCountryAsnCountStmt.get(normalized);
                const count = Number.isFinite(row?.asn_count)
                    ? row.asn_count
                    : Number.parseInt(row?.asn_count ?? '0', 10);
                return Number.isFinite(count) ? count : 0;
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to count ASNs by country', error);
                return 0;
            }
        };

        const getCountryList = () => {
            if (!selectCountryListStmt) {
                return [];
            }
            try {
                return selectCountryListStmt
                    .all()
                    .map((row) => normalizeText(row.country))
                    .filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query country list', error);
                return [];
            }
        };

        const getAsnsForOrg = (orgName, limit = 3, excludeAsn = null) => {
            const normalized = normalizeText(orgName);
            if (!normalized) {
                return [];
            }
            const safeLimit = normalizeLimit(limit, 3);
            const exclude = parseAsnNumber(excludeAsn);
            try {
                return selectAsnsByOrgStmt
                    .all(normalized, exclude, exclude, safeLimit)
                    .map(normalizeAsnRow)
                    .filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query ASNs for org', error);
                return [];
            }
        };

        const getOrgSummaryBySlug = (orgSlug) => {
            if (!selectOrgSummaryBySlugStmt || !selectOrgNameBySlugStmt) {
                return null;
            }
            const normalized = normalizeOrgSlug(orgSlug);
            if (!normalized) {
                return null;
            }
            try {
                const summary = selectOrgSummaryBySlugStmt.get(normalized);
                if (!summary) {
                    return null;
                }
                const asnCount = Number.isFinite(summary.asn_count)
                    ? summary.asn_count
                    : Number.parseInt(summary.asn_count, 10);
                if (!Number.isFinite(asnCount) || asnCount <= 0) {
                    return null;
                }
                const orgRow = selectOrgNameBySlugStmt.get(normalized);
                const domainRow = selectOrgDomainBySlugStmt
                    ? selectOrgDomainBySlugStmt.get(normalized)
                    : null;
                return {
                    slug: normalized,
                    organization: normalizeText(orgRow?.organization),
                    ipv4Amount: summary.ipv4_amount ?? null,
                    ipv6Amount: summary.ipv6_amount ?? null,
                    asnCount,
                    domain: normalizeText(domainRow?.domain),
                };
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query org summary', error);
                return null;
            }
        };

        const getAsnsByOrgSlug = (orgSlug) => {
            if (!selectAsnsByOrgSlugStmt) {
                return [];
            }
            const normalized = normalizeOrgSlug(orgSlug);
            if (!normalized) {
                return [];
            }
            try {
                return selectAsnsByOrgSlugStmt.all(normalized).map((row) => {
                    const {data, rawJson, parseError} = parseAsnJson(row.json);
                    return {
                        asn: row.asn,
                        handle: normalizeText(row.handle),
                        organization: normalizeText(row.organization),
                        ipv4Amount: row.ipv4_amount ?? null,
                        ipv6Amount: row.ipv6_amount ?? null,
                        domain: normalizeText(row.domain),
                        data,
                        rawJson,
                        parseError,
                    };
                });
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query ASNs by org slug', error);
                return [];
            }
        };

        const findOrgByPrefix = (prefix) => {
            if (!selectOrgByPrefixStmt) {
                return null;
            }
            const normalized = normalizeText(prefix);
            if (!normalized) {
                return null;
            }
            const safePrefix = normalized.replace(/[%_]+/g, '').slice(0, 100);
            if (!safePrefix) {
                return null;
            }
            try {
                // eslint-disable-next-line no-console
                console.log('ASN org prefix lookup', {prefix: normalized, query: `${safePrefix}%`});
                const row = selectOrgByPrefixStmt.get(`${safePrefix}%`);
                if (!row) {
                    // eslint-disable-next-line no-console
                    console.log('ASN org prefix lookup result: none');
                    return null;
                }
                const asnCount = Number.isFinite(row.asn_count)
                    ? row.asn_count
                    : Number.parseInt(row.asn_count, 10);
                // eslint-disable-next-line no-console
                console.log('ASN org prefix lookup result', {
                    slug: row.slug,
                    organization: row.organization,
                    asnCount,
                });
                return {
                    slug: normalizeOrgSlug(row.slug),
                    organization: normalizeText(row.organization),
                    ipv4Amount: row.ipv4_amount ?? null,
                    ipv6Amount: row.ipv6_amount ?? null,
                    asnCount: Number.isFinite(asnCount) ? asnCount : 0,
                };
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query organization prefix', error);
                return null;
            }
        };

        return {
            store: {
                isAvailable: () => true,
                parseAsnNumber,
                getAsnInfo,
                getTopAsnsByIpv4,
                getTopAsnsByIpv6,
                getTopOrganizationsByIpv4,
                getTopCountriesByIpv4,
                getAsnsByCountry,
                getCountryAsnCount,
                getCountryList,
                getAsnsForOrg,
                getOrgSummaryBySlug,
                getAsnsByOrgSlug,
                findOrgByPrefix,
            },
            close: () => {
                try {
                    db.close();
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.error('Failed to close ASN info database', error);
                }
            },
        };
    } catch (error) {
        if (db) {
            try {
                db.close();
            } catch (closeError) {
                // eslint-disable-next-line no-console
                console.error('Failed to close ASN info database after load error', closeError);
            }
        }
        // eslint-disable-next-line no-console
        console.error('Failed to load ASN info database', error);
        return {
            store: createEmptyStore(),
            close: () => {},
        };
    }
};

const STORE_METHOD_NAMES = Object.freeze([
    'isAvailable',
    'parseAsnNumber',
    'getAsnInfo',
    'getTopAsnsByIpv4',
    'getTopAsnsByIpv6',
    'getTopOrganizationsByIpv4',
    'getTopCountriesByIpv4',
    'getAsnsByCountry',
    'getCountryAsnCount',
    'getCountryList',
    'getAsnsForOrg',
    'getOrgSummaryBySlug',
    'getAsnsByOrgSlug',
    'findOrgByPrefix',
]);

export const createAsnInfoStore = (dbPath) => {
    const emptyStore = createEmptyStore();
    let active = createAsnInfoStoreInstance(dbPath);
    let lastUpdate = active.store.isAvailable() ? (getDbMtime(dbPath) || new Date()) : null;

    const safeClose = (instance) => {
        if (!instance || typeof instance.close !== 'function') {
            return;
        }
        instance.close();
    };

    const swapInstance = (nextInstance) => {
        const previous = active;
        active = nextInstance;
        safeClose(previous);
    };

    const proxyStore = {
        reload: () => {
            if (!dbPath) {
                return {ok: false, reason: 'not_configured'};
            }
            const dbMtime = getDbMtime(dbPath);
            if (lastUpdate && dbMtime && dbMtime.getTime() <= lastUpdate.getTime()) {
                return {ok: true, skipped: true, reason: 'not_modified', lastUpdate};
            }
            const nextInstance = createAsnInfoStoreInstance(dbPath);
            if (!nextInstance.store.isAvailable()) {
                safeClose(nextInstance);
                return {ok: false, reason: 'load_failed'};
            }
            swapInstance(nextInstance);
            lastUpdate = dbMtime || new Date();
            return {ok: true, skipped: false, lastUpdate};
        },
        getLastUpdate: () => lastUpdate,
        close: () => {
            const previous = active;
            active = {
                store: emptyStore,
                close: () => {},
            };
            safeClose(previous);
            lastUpdate = null;
        },
    };

    STORE_METHOD_NAMES.forEach((methodName) => {
        proxyStore[methodName] = (...args) => {
            const method = active.store?.[methodName];
            if (typeof method === 'function') {
                return method(...args);
            }
            return emptyStore[methodName](...args);
        };
    });

    return proxyStore;
};
