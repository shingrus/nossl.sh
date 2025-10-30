import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import dns from 'dns/promises';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

const regionNames =
  typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'templates'));

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

app.use('/static', express.static(path.join(__dirname, 'static'), { maxAge: '1h' }));

const faviconPath = path.join(__dirname, 'static', 'favicon.svg');

app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/svg+xml');
  res.sendFile(faviconPath);
});

const getClientIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ip = forwardedFor.split(',')[0].trim();
    if (ip) {
      return ip;
    }
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return realIp;
  }
  return req.ip;
};

const getScheme = (req) => {
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto) {
    return forwardedProto.split(',')[0].trim().toLowerCase();
  }
  return req.secure ? 'https' : 'http';
};

const normalizeHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
      .sort((a, b) => a[0].localeCompare(b[0]))
  );

const getCountryData = (req) => {
  const candidateHeaders = [
    'cf-ipcountry',
    'cloudfront-viewer-country',
    'x-vercel-ip-country',
    'x-geo-country',
    'x-country-code',
    'x-appengine-country',
  ];

  const codeHeader = candidateHeaders
    .map((header) => req.headers[header])
    .find((value) => typeof value === 'string' && value.trim().length);

  if (!codeHeader) {
    return { countryCode: '', countryName: 'Unknown' };
  }

  const code = codeHeader.trim().slice(0, 2).toUpperCase();

  try {
    const countryName = regionNames?.of(code) || 'Unknown';
    return { countryCode: code, countryName };
  } catch (error) {
    return { countryCode: code, countryName: 'Unknown' };
  }
};

const isPublicIp = (ip) => {
  if (!ip) {
    return false;
  }

  const cleaned = ip.replace(/^::ffff:/, '');
  const version = net.isIP(cleaned);

  if (version === 4) {
    const [a, b] = cleaned.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) {
      return false;
    }
    if (a === 169 && b === 254) {
      return false;
    }
    if (a === 192 && b === 168) {
      return false;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return false;
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return false;
    }
    if (a === 198 && (b === 18 || b === 19)) {
      return false;
    }
    return true;
  }

  if (version === 6) {
    const lower = cleaned.toLowerCase();
    if (lower === '::1') {
      return false;
    }
    if (lower.startsWith('fe80') || lower.startsWith('fd') || lower.startsWith('fc')) {
      return false;
    }
    return true;
  }

  return false;
};

const resolveReverseDns = async (ip) => {
  if (!isPublicIp(ip)) {
    return '—';
  }

  try {
    const cleaned = ip.replace(/^::ffff:/, '');
    const results = await dns.reverse(cleaned);
    if (Array.isArray(results) && results.length > 0) {
      return results[0];
    }
    return '—';
  } catch (error) {
    return '—';
  }
};

app.get('/', async (req, res) => {
  const clientIp = getClientIp(req);
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  if (userAgent.includes('curl')) {
    res.type('text/plain');
    res.send(`${clientIp}\n`);
    return;
  }

  const scheme = getScheme(req);
  const status = scheme === 'https' ? 'Secure connection detected.' : 'Unsecured connection detected.';
  const headers = normalizeHeaders(req.headers);
  const generatedAt = new Date();
  const { countryCode, countryName } = getCountryData(req);
  const rDNS = await resolveReverseDns(clientIp);

  res.render('index', {
    scheme,
    status,
    clientIp,
    headers,
    generatedAt,
    countryCode,
    countryName,
    rDNS,
  });
});

app.get('/api/request-info', async (req, res) => {
  const scheme = getScheme(req);
  const clientIp = getClientIp(req);
  const headers = normalizeHeaders(req.headers);
  const { countryCode, countryName } = getCountryData(req);
  const rDNS = await resolveReverseDns(clientIp);

  res.json({
    scheme,
    status: scheme === 'https' ? 'secure' : 'insecure',
    clientIp,
    headers,
    countryCode,
    countryName,
    rDNS,
  });
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`nossl.sh listening on port ${PORT}`);
});
