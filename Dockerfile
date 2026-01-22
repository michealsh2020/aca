# ---------- Build Frontend ----------
FROM node:18-alpine AS frontend-builder
WORKDIR /app

# Copy frontend package files
COPY package*.json ./
RUN npm ci

# Copy frontend source and build
COPY . .
RUN npm run build

# ---------- Build Backend ----------
FROM node:18-alpine AS backend-builder
WORKDIR /app

# Copy backend package files
COPY backend/package*.json ./
RUN npm ci --only=production

# ---------- Production stage ----------
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S appuser -u 1001

# Copy backend dependencies and source
COPY --from=backend-builder /app/node_modules ./backend/node_modules
COPY backend/ ./backend/

# Copy built frontend to the location expected by the updated backend
COPY --from=frontend-builder /app/build ./frontend/build

# Change ownership
RUN chown -R appuser:nodejs /app
USER appuser

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/ || exit 1

# Start the backend server
CMD ["node", "backend/index.js"] 