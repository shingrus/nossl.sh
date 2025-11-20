import crypto from 'crypto';
import {createClient as createRedisClient} from 'redis';

const createShareReportStore = ({redisUrl, ttlSeconds, connectTimeoutMs = 1000}) => {
    let client = null;
    let connectPromise = null;
    let available = false;

    const resetClient = () => {
        const current = client;
        client = null;
        connectPromise = null;
        if (current) {
            current.quit().catch(() => {
                // ignore cleanup errors
            });
        }
    };

    const startConnection = () => {
        if (connectPromise) {
            return connectPromise;
        }

        const nextClient = createRedisClient({
            url: redisUrl,
            socket: {
                connectTimeout: connectTimeoutMs,
            },
        });
        client = nextClient;
        nextClient.on('error', () => {
            available = false;
            resetClient();
        });

        connectPromise = nextClient
            .connect()
            .then(() => {
                available = true;
                return nextClient;
            })
            .catch(() => {
                available = false;
                resetClient();
                return null;
            });

        return connectPromise;
    };

    const getClient = async () => {
        const activeClient = await startConnection();
        if (!activeClient) {
            available = false;
            return null;
        }
        return activeClient;
    };

    const saveSnapshot = async (snapshot) => {
        try {
            const redis = await getClient();
            if (!redis) {
                return null;
            }

            const reportId = crypto.randomUUID();
            await redis.set(`shared_report:${reportId}`, JSON.stringify(snapshot), {
                EX: ttlSeconds,
            });
            available = true;
            return reportId;
        } catch (error) {
            available = false;
            resetClient();
            return null;
        }
    };

    const readSnapshot = async (reportId) => {
        try {
            const redis = await getClient();
            if (!redis) {
                return null;
            }

            const raw = await redis.get(`shared_report:${reportId}`);
            if (!raw) {
                return null;
            }

            try {
                return JSON.parse(raw);
            } catch (error) {
                return null;
            }
        } catch (error) {
            available = false;
            resetClient();
            return null;
        }
    };

    const isAvailable = () => {
        if (!available && !connectPromise) {
            startConnection().catch(() => {
                available = false;
            });
        }
        return available;
    };

    startConnection().catch(() => {
        available = false;
    });

    return {
        isAvailable,
        saveSnapshot,
        readSnapshot,
    };
};

export const createSharedReportService = ({
    redisUrl = 'redis://127.0.0.1:6379',
    ttlSeconds = 24 * 60 * 60,
    connectTimeoutMs = 1000,
} = {}) => {
    const store = createShareReportStore({redisUrl, ttlSeconds, connectTimeoutMs});

    const buildSnapshot = (baseData) => {
        const generatedAtIso =
            baseData?.generatedAt instanceof Date
                ? baseData.generatedAt.toISOString()
                : baseData?.generatedAt ?? new Date().toISOString();

        return {
            ...baseData,
            generatedAt: generatedAtIso,
        };
    };

    const getShareUrl = (req, reportId) => {
        const host = req.get('host') || 'nossl.sh';
        return `http://${host}/report/${reportId}`;
    };

    return {
        store,
        buildSnapshot,
        getShareUrl,
    };
};
