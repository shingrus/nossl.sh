# nossl.sh

nossl.sh is a lightweight diagnostic page. It returns a search-engine-friendly HTML
page that reports the client's IP address, request headers, and whether the connection reached the service over HTTP or HTTPS.
The project is packaged for deployment on Google Cloud Run.

## Features

- **SEO-friendly HTML** page with descriptive metadata.
- **Connection status** highlighting whether the request arrived via HTTP or HTTPS.
- **Client IP** detection with support for standard proxy headers.
- **Request header table** for quick debugging.
- **JSON API** at `/api/request-info` for programmatic use.
- **Health endpoint** at `/healthz` for Cloud Run monitoring.
- **Honeypot log** at `/honeypot` (HTML) and `/api/honeypot` (JSON) showing the top IPs probing `.env`, persisted in SQLite.

## Local development

```bash
npm install
npm run dev
```

Then visit [http://localhost:8080](http://localhost:8080).

To run without live reloading:

```bash
npm start
```

## Configuration

- Override the default SQLite database path by setting the `SQLDB` environment variable before starting the server.
- Control honeypot retention with `MAX_HONEYPOT` (defaults to 1024). When the table exceeds 110% of this value, the oldest rows are pruned.

## Container build

```bash
docker build -t gcr.io/PROJECT-ID/nossl-sh:latest .
```

## Deploy to Cloud Run

```bash
gcloud run deploy nossl-sh \
  --source . \
  --region REGION \
  --allow-unauthenticated
```

Adjust `PROJECT-ID` and `REGION` to match your Google Cloud project.
