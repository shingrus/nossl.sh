import crypto from 'crypto';

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

const randomAlphaNumeric = (length) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return result;
};

const randomPrivateIp = () => {
  const octet = () => crypto.randomInt(1, 255);
  return `10.${octet()}.${octet()}.${octet()}`;
};



export const generateFakeEnvFile = () => {
  const base64Key = crypto.randomBytes(32).toString('base64');
  const dbPassword = randomAlphaNumeric(16);
  const redisHost = randomPrivateIp();
  const redisPassword = randomAlphaNumeric(12);
  const mailFragmentA = randomAlphaNumeric(22);
  const mailFragmentB = `${randomAlphaNumeric(16)}-${randomAlphaNumeric(7)}`;
  const stripePublic = `pk_live_${randomAlphaNumeric(24)}`;
  const stripeSecret = `sk_live_${randomAlphaNumeric(32)}`;
  const sentryKey = randomHex(20);
  const sentryProject = crypto.randomInt(100000, 999999).toString();
  const internalApiHost = randomAlphaNumeric(9).toLowerCase();
  const awsAccessKey = `AKIA${randomAlphaNumeric(16).toUpperCase()}`;
  const awsSecret = randomAlphaNumeric(40);

  return [
    '# Application',
    'APP_NAME=AcmePortal',
    'APP_ENV=production',
    `APP_KEY=base64:${base64Key}`,
    'APP_DEBUG=false',
    'APP_URL=https://app.acme.internal',
    'APP_TIMEZONE=UTC',
    'LOG_CHANNEL=stack',
    'LOG_LEVEL=info',
    '',
    '# Database',
    'DB_CONNECTION=mysql',
    `DB_HOST=${randomPrivateIp()}`,
    'DB_PORT=3306',
    'DB_DATABASE=acme_prod',
    'DB_USERNAME=acme_app',
    `DB_PASSWORD=${dbPassword}`,
    'MYSQL_ATTR_SSL_CA=/etc/ssl/certs/ca-certificates.crt',
    '',
    '# Cache / Session / Queue',
    'CACHE_DRIVER=redis',
    'SESSION_DRIVER=redis',
    'SESSION_LIFETIME=120',
    'QUEUE_CONNECTION=redis',
    '',
    '# Redis',
    `REDIS_HOST=${redisHost}`,
    `REDIS_PASSWORD=${redisPassword}`,
    'REDIS_PORT=6379',
    '',
    '# Mail',
    'MAIL_MAILER=smtp',
    'MAIL_HOST=smtp.nossl.sh',
    'MAIL_PORT=587',
    'MAIL_USERNAME=apikey',
    `MAIL_PASSWORD=SG.${mailFragmentA}.${mailFragmentB}`,
    'MAIL_ENCRYPTION=tls',
    'MAIL_FROM_ADDRESS=noreply@acme.example',
    'MAIL_FROM_NAME="Acme Portal"',
    '',
    '# AWS S3',
    'FILESYSTEM_DRIVER=s3',
    `AWS_ACCESS_KEY_ID=${awsAccessKey}`,
    `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
    'AWS_DEFAULT_REGION=eu-west-1',
    'AWS_BUCKET=acme-prod-eu1',
    '',
    '# Payments',
    `STRIPE_KEY=${stripePublic}`,
    `STRIPE_SECRET=${stripeSecret}`,
    '',
    '# Monitoring / Error reporting',
    `SENTRY_DSN=https://${sentryKey}@o12345.ingest.sentry.io/${sentryProject}`,
    '',
    '# Misc internal services',
    `INTERNAL_API_URL=http://${internalApiHost}.nossl.sh:80`,
    'FEATURE_FLAGS=payments,ab_tests,geoip',
  ].join('\n');
};
