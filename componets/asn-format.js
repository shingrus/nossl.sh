export const formatIpv4Amount = (value) => {
    const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!raw || !/^\d+$/.test(raw)) {
        if (value == null || (typeof value === 'string' && value.trim() === '')) {
            return 'N/A';
        }
        return String(value);
    }
    return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};
