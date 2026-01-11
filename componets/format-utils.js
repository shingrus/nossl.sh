export const formatTimestamp = (value) => {
    try {
        const dt = value instanceof Date ? value : new Date(value ?? Date.now());
        if (Number.isNaN(dt.getTime())) {
            return '';
        }
        return dt.toISOString().replace('T', ' ').replace(/\..+/, ' UTC');
    } catch (error) {
        return '';
    }
};
