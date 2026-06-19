FROM node:20-slim

WORKDIR /app

# Core system tools + all runtimes
RUN apt-get update && apt-get install -y \
    openjdk-21-jdk \
    python3 \
    python3-pip \
    python3-venv \
    golang \
    rustc \
    cargo \
    gcc \
    g++ \
    make \
    bash \
    curl \
    git \
    procps \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Node deps first (better caching)
COPY package*.json ./
RUN npm install

# App
COPY . .

# Workspace root (isolated execution area)
RUN mkdir -p /sandbox

ENV SANDBOX_ROOT=/sandbox
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
