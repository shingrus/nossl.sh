# syntax=docker/dockerfile:1
FROM node:20-slim AS base

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY static ./static
COPY templates ./templates
COPY server.js ./

EXPOSE 8080

CMD ["npm", "start"]
