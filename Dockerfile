FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN npm install --production=false

# Copy source
COPY . .

# Build web frontend
RUN npm run build

# Serve static files from the API server
ENV NODE_ENV=production
ENV CORS_ORIGIN=*
EXPOSE 3001

CMD ["node", "apps/api/src/index.js"]
