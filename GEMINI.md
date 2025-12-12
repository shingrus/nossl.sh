# Project Overview

This is a Node.js project that runs a diagnostic web page called "nossl.sh". The main purpose of the application is to report information about a client's connection, such as their IP address, request headers, and whether the connection is HTTP or HTTPS. It's designed to be SEO-friendly and can be deployed using Docker.

The project uses Express.js as the web server, EJS for templating, and `better-sqlite3` for a local SQLite database. It also has features for sharing reports (using Redis), a honeypot to log probes for `.env` files, and GeoIP lookups using the `maxmind` library.

# Building and Running

## Local Development

To run the application in a development environment with live reloading:

```bash
npm install
npm run dev
```

The application will be available at `http://localhost:8080`.

## Production

To run the application in a production environment:

```bash
npm install --omit=dev
npm start
```


# Development Conventions

*   **ES Modules:** The project uses ES modules (`"type": "module"` in `package.json`).
*   **Project Structure:**
    *   `server.js`: The main application entry point.
    *   components (in the `componets/` directory): Contains modules for different parts of the application (e.g., `honeypot.js`, `shared-report.js`).
    *   `templates/`: Contains EJS templates for rendering HTML pages.
    *   `static/`: Contains static assets like CSS, images, and `robots.txt`.
    *   `infra/`: Contains infrastructure configuration, such as the `nginx.conf` file.
    *   `deploy-nossl.sh`: A sophisticated script for deploying the application to a production environment.
*   **Deployment:** The `deploy-nossl.sh` script suggests a production environment that uses `systemd` for service management and `nginx` as a reverse proxy. The script is designed for zero-downtime deployments and includes features like backups, rollbacks, and health checks.
