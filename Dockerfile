# Stage 1: Build frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
ARG VITE_APP_HOSTNAME
ENV VITE_APP_HOSTNAME=$VITE_APP_HOSTNAME
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS backend-builder
WORKDIR /build/backend
COPY backend/package.json ./
RUN npm install
COPY backend/ ./
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine AS runtime
WORKDIR /app

# Install production deps only
COPY backend/package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled backend
COPY --from=backend-builder /build/backend/dist ./dist

# Copy static SQL file (not emitted by tsc)
COPY --from=backend-builder /build/backend/src/db/schema.sql ./dist/db/schema.sql

# Copy frontend build into static dir served by backend
COPY --from=frontend-builder /build/frontend/dist ./public

EXPOSE 3000
CMD ["node", "dist/index.js"]
