# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Install dependencies in a dedicated layer
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev

# Production image
FROM base AS production
ENV NODE_ENV=production

# Copy node_modules from deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy application source
COPY . .

# Expose service port (matches PORT env default)
EXPOSE 3000

# The service expects configuration via environment variables or an .env file mounted at runtime
CMD ["node", "-r", "dotenv/config", "server.js", "dotenv_config_path=./.env"]
