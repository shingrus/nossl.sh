(() => {
    const req = window.__REQUEST__ || {};
    const $ = (sel) => document.querySelector(sel);

    // Online/Offline
    const setOnline = (isOnline) => {
        $('#online-text').textContent = isOnline ? "You're online" : "You're offline";
        $('#online-dot').style.background = isOnline ? 'var(--good)' : 'var(--bad)';
    };
    window.addEventListener('online',  () => setOnline(true));
    window.addEventListener('offline', () => setOnline(false));
    setOnline(navigator.onLine);

    // Connection type (Network Information API where supported)
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const updateConn = () => {
        $('#conn-type').textContent = conn ? (conn.effectiveType || 'unknown') : 'unknown';
        $('#eff-type').textContent = conn && conn.effectiveType ? conn.effectiveType : '—';
        $('#downlink').textContent  = conn && typeof conn.downlink === 'number' ? `${conn.downlink} Mbps` : '—';
        $('#rtt').textContent       = conn && typeof conn.rtt === 'number' ? `${conn.rtt} ms` : '—';
    };
    updateConn();
    if (conn) conn.addEventListener('change', updateConn);

    // Time blocks
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    $('#tz').textContent = tz || '—';
    const tick = () => {
        const now = new Date();
        $('#local-time').textContent = now.toLocaleString();
        $('#utc-time').textContent   = now.toISOString().replace('T',' ').replace('Z',' UTC');
    };
    tick(); setInterval(tick, 1000);

    // Fill IP if not provided client-side later; keep what server rendered
    if (req.scheme) $('#proto').textContent = req.scheme.toUpperCase();

    // Lightweight ping: 5 samples to /healthz (no-store)
    async function samplePing() {
        const run = async () => {
            const t0 = performance.now();
            try {
                await fetch('/healthz', { method: 'GET', cache: 'no-store', headers: { 'x-nossl-ping': '1' } });
            } catch (_) { /* ignore */ }
            return performance.now() - t0;
        };
        const n = 5;
        const samples = [];
        for (let i = 0; i < n; i++) samples.push(await run());
        samples.sort((a,b) => a-b);
        const median = samples[Math.floor(n/2)];
        $('#ping').textContent = `${Math.round(median)} ms`;
    }
    samplePing();

    // Copy IP button
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.copy');
        if (!btn) return;
        const value = btn.getAttribute('data-copy') || $('#ip')?.textContent || '';
        if (!value) return;
        navigator.clipboard?.writeText(value).then(() => {
            const old = btn.textContent; btn.textContent = 'copied'; setTimeout(() => btn.textContent = old, 900);
        });
    });
})();
