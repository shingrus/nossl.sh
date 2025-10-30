import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

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
  Object.entries(headers)
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)])
    .sort((a, b) => a[0].localeCompare(b[0]));

const randomSubdomain = () => {
  const words = [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
    'golf',
    'hotel',
    'india',
    'juliet',
    'kilo',
    'lima',
    'mike',
    'november',
    'oscar',
    'papa',
    'quebec',
    'romeo',
    'sierra',
    'tango',
    'uniform',
    'victor',
    'whiskey',
    'xray',
    'yankee',
    'zulu',
  ];
  return words[crypto.randomInt(0, words.length)];
};

const renderIndex = (req, res) => {
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

  res.render('index', {
    scheme,
    status,
    clientIp,
    headers,
    generatedAt,
  });
};

app.get('/', (req, res) => {
  const scheme = getScheme(req);
  if (scheme === 'https') {
    const subdomain = randomSubdomain();
    const redirectUrl = `http://${subdomain}.nossl.sh/check`;

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.type('text/html');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting...</title></head><body><script>window.location.href='${redirectUrl}';</script></body></html>`);
    return;
  }

  renderIndex(req, res);
});

app.get('/check', (req, res) => {
  renderIndex(req, res);
});

app.get('/api/request-info', (req, res) => {
  const scheme = getScheme(req);
  const clientIp = getClientIp(req);
  const headers = normalizeHeaders(req.headers).reduce((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});

  res.json({
    scheme,
    status: scheme === 'https' ? 'secure' : 'insecure',
    clientIp,
    headers,
  });
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`nossl.sh listening on port ${PORT}`);
});
