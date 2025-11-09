FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code and necessary files (explicitly excluding sensitive files)
COPY src/ ./src/
COPY dist/ ./dist/
COPY tsconfig.json ./
COPY package*.json ./
COPY README.md ./
COPY .env.example ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S finfluencer -u 1001

# Change ownership of the app directory
RUN chown -R finfluencer:nodejs /app
USER finfluencer

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('Health check')" || exit 1

# Expose port (if needed for health checks)
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production
ENV TZ=Europe/Istanbul

# Run the application
CMD ["node", "dist/index.js"]
