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

const createEmptyStore = () => ({
    isAvailable: () => false,
    parseAsnNumber,
    getAsnInfo: () => null,
    getTopAsnsByIpv4: () => [],
    getTopAsnsByIpv4Count: () => 0,
    getTopAsnsByIpv6: () => [],
    getTopAsnsByIpv6Count: () => 0,
    getTopOrganizationsByIpv4: () => [],
    getTopOrganizationsByIpv4Count: () => 0,
    getAsnsForOrg: () => [],
    getOrgSummaryBySlug: () => null,
    getAsnsByOrgSlug: () => [],
});

export const createAsnInfoStore = (dbPath) => {
    if (!dbPath) {
        return createEmptyStore();
    }
    try {
        const db = new Database(dbPath, {readonly: true, fileMustExist: true});
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
        const selectTopAsnsByIpv4Stmt = db.prepare(`
            SELECT a.asn,
                   a.handle,
                   NULLIF(TRIM(a.organization), '') AS organization,
                   CAST(a.ipv4_amount AS TEXT) AS ipv4_amount,
                   CAST(a.ipv6_amount AS REAL) AS ipv6_amount,
                   d.domain AS domain
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE a.ipv4_amount IS NOT NULL
               AND CAST(a.ipv4_amount AS TEXT) != ''
               AND CAST(a.ipv4_amount AS TEXT) != '0'
             ORDER BY LENGTH(CAST(a.ipv4_amount AS TEXT)) DESC,
                      CAST(a.ipv4_amount AS TEXT) DESC
             LIMIT ?
            OFFSET ?
        `);
        const selectTopAsnsByIpv4CountStmt = db.prepare(`
            SELECT COUNT(*) AS total
              FROM asn a
             WHERE a.ipv4_amount IS NOT NULL
               AND CAST(a.ipv4_amount AS TEXT) != ''
               AND CAST(a.ipv4_amount AS TEXT) != '0'
        `);
        const selectTopAsnsByIpv6Stmt = db.prepare(`
            SELECT a.asn,
                   a.handle,
                   NULLIF(TRIM(a.organization), '') AS organization,
                   CAST(a.ipv4_amount AS TEXT) AS ipv4_amount,
                   CAST(a.ipv6_amount AS REAL) AS ipv6_amount,
                   d.domain AS domain
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE a.ipv6_amount IS NOT NULL
               AND CAST(a.ipv6_amount AS REAL) > 0
             ORDER BY CAST(a.ipv6_amount AS REAL) DESC
             LIMIT ?
            OFFSET ?
        `);
        const selectTopAsnsByIpv6CountStmt = db.prepare(`
            SELECT COUNT(*) AS total
              FROM asn a
             WHERE a.ipv6_amount IS NOT NULL
               AND CAST(a.ipv6_amount AS REAL) > 0
        `);
        const selectTopOrganizationsByIpv4Stmt = db.prepare(`
            SELECT NULLIF(TRIM(a.organization), '') AS organization,
                   CAST(SUM(
                       CASE
                           WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                           ELSE CAST(a.ipv4_amount AS INTEGER)
                       END
                   ) AS TEXT) AS ipv4_amount,
                   COUNT(*) AS asn_count
              FROM asn a
             WHERE a.organization IS NOT NULL
               AND TRIM(a.organization) != ''
             GROUP BY TRIM(a.organization)
            HAVING SUM(
                       CASE
                           WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                           ELSE CAST(a.ipv4_amount AS INTEGER)
                       END
                   ) > 0
             ORDER BY LENGTH(CAST(SUM(
                       CASE
                           WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                           ELSE CAST(a.ipv4_amount AS INTEGER)
                       END
                   ) AS TEXT)) DESC,
                      SUM(
                       CASE
                           WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                           ELSE CAST(a.ipv4_amount AS INTEGER)
                       END
                   ) DESC
             LIMIT ?
            OFFSET ?
        `);
        const selectTopOrganizationsByIpv4CountStmt = db.prepare(`
            SELECT COUNT(*) AS total
              FROM (
                SELECT TRIM(a.organization) AS organization
                  FROM asn a
                 WHERE a.organization IS NOT NULL
                   AND TRIM(a.organization) != ''
                 GROUP BY TRIM(a.organization)
                HAVING SUM(
                           CASE
                               WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                               ELSE CAST(a.ipv4_amount AS INTEGER)
                           END
                       ) > 0
              ) AS ranked_orgs
        `);
        const selectAsnsByOrgStmt = db.prepare(`
            SELECT a.asn,
                   a.handle,
                   NULLIF(TRIM(a.organization), '') AS organization,
                   CAST(a.ipv4_amount AS TEXT) AS ipv4_amount,
                   CAST(a.ipv6_amount AS REAL) AS ipv6_amount,
                   d.domain AS domain
              FROM asn a
              LEFT JOIN asn_domain d ON a.asn = d.asn
             WHERE TRIM(a.organization) = ?
               AND (? IS NULL OR a.asn != ?)
             ORDER BY LENGTH(COALESCE(CAST(a.ipv4_amount AS TEXT), '0')) DESC,
                      COALESCE(CAST(a.ipv4_amount AS TEXT), '0') DESC
             LIMIT ?
        `);
        const selectOrgSummaryBySlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT CAST(SUM(
                           CASE
                               WHEN a.ipv4_amount IS NULL OR CAST(a.ipv4_amount AS TEXT) = '' THEN 0
                               ELSE CAST(a.ipv4_amount AS INTEGER)
                           END
                       ) AS TEXT) AS ipv4_amount,
                       CAST(SUM(
                           CASE
                               WHEN a.ipv6_amount IS NULL OR CAST(a.ipv6_amount AS TEXT) = '' THEN 0
                               ELSE CAST(a.ipv6_amount AS REAL)
                           END
                       ) AS REAL) AS ipv6_amount,
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
        const selectAsnsByOrgSlugStmt = hasOrgSlugColumn
            ? db.prepare(`
                SELECT a.asn,
                       a.handle,
                       NULLIF(TRIM(a.organization), '') AS organization,
                       CAST(a.ipv4_amount AS TEXT) AS ipv4_amount,
                       CAST(a.ipv6_amount AS REAL) AS ipv6_amount,
                       d.domain AS domain,
                       a.json AS json
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

        const normalizeOffset = (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return 0;
            }
            return parsed;
        };

        const getTopAsnsByIpv4 = (limit = 25, offset = 0) => {
            const safeLimit = normalizeLimit(limit, 25);
            const safeOffset = normalizeOffset(offset);
            try {
                return selectTopAsnsByIpv4Stmt.all(safeLimit, safeOffset).map(normalizeAsnRow).filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv4 ASNs', error);
                return [];
            }
        };

        const getTopAsnsByIpv4Count = () => {
            try {
                const row = selectTopAsnsByIpv4CountStmt.get();
                const total = Number.isFinite(row?.total) ? row.total : Number.parseInt(row?.total, 10);
                return Number.isFinite(total) && total > 0 ? total : 0;
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv4 ASN count', error);
                return 0;
            }
        };

        const getTopAsnsByIpv6 = (limit = 25, offset = 0) => {
            const safeLimit = normalizeLimit(limit, 25);
            const safeOffset = normalizeOffset(offset);
            try {
                return selectTopAsnsByIpv6Stmt.all(safeLimit, safeOffset).map(normalizeAsnRow).filter(Boolean);
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv6 ASNs', error);
                return [];
            }
        };

        const getTopAsnsByIpv6Count = () => {
            try {
                const row = selectTopAsnsByIpv6CountStmt.get();
                const total = Number.isFinite(row?.total) ? row.total : Number.parseInt(row?.total, 10);
                return Number.isFinite(total) && total > 0 ? total : 0;
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top IPv6 ASN count', error);
                return 0;
            }
        };

        const getTopOrganizationsByIpv4 = (limit = 25, offset = 0) => {
            const safeLimit = normalizeLimit(limit, 25);
            const safeOffset = normalizeOffset(offset);
            try {
                return selectTopOrganizationsByIpv4Stmt.all(safeLimit, safeOffset).map((row) => {
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

        const getTopOrganizationsByIpv4Count = () => {
            try {
                const row = selectTopOrganizationsByIpv4CountStmt.get();
                const total = Number.isFinite(row?.total) ? row.total : Number.parseInt(row?.total, 10);
                return Number.isFinite(total) && total > 0 ? total : 0;
            } catch (error) {
                // eslint-disable-next-line no-console
                console.error('Failed to query top organizations count', error);
                return 0;
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

        return {
            isAvailable: () => true,
            parseAsnNumber,
            getAsnInfo,
            getTopAsnsByIpv4,
            getTopAsnsByIpv4Count,
            getTopAsnsByIpv6,
            getTopAsnsByIpv6Count,
            getTopOrganizationsByIpv4,
            getTopOrganizationsByIpv4Count,
            getAsnsForOrg,
            getOrgSummaryBySlug,
            getAsnsByOrgSlug,
        };
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load ASN info database', error);
        return createEmptyStore();
    }
};
