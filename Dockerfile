FROM node:20-slim

WORKDIR /app

# Install system dependencies required by Playwright's Chromium browser.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libx11-6 \
    libxrandr2 \
    libxinerama1 \
    libxi6 \
    libxext6 \
    libxcursor1 \
    libxdamage1 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcairo2 \
    libdbus-1-3 \
    libatspi2.0-0 \
    libgdk-pixbuf-2.0-0 \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first to leverage Docker layer caching.
COPY package.json package-lock.json* ./

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN npm install --omit=dev

RUN npx playwright install --with-deps chromium

# Copy the rest of the application source.
COPY . .

ENV NODE_ENV=production

CMD ["node", "bootstrap.js"]
