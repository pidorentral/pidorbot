# Node.js 22 on Debian Bookworm — required for Playwright/Chromium runtime libraries and Playwright's Node >=20 engine requirement
FROM node:22-bookworm

# Install system dependencies required by Playwright/Chromium in headless mode
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    libglib2.0-0 \
    libx11-6 \
    libxkbcommon0 \
    libnss3 \
    libxss1 \
    libasound2 \
    libdbus-1-3 \
    libgtk-3-0 \
    fonts-liberation \
    libappindicator3-1 \
    libxext6 \
    libxrender1 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first to leverage Docker layer caching.
# This also triggers the postinstall hook (`playwright install chromium`).
COPY package*.json ./
RUN npm install

# Copy the rest of the application source
COPY . .

# Ensure the Chromium binary Playwright expects is present (idempotent if postinstall already ran)
RUN npx playwright install chromium --with-deps

EXPOSE 3000

CMD ["npm", "start"]
