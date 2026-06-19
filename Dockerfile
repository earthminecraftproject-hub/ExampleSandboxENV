FROM node:20-slim

WORKDIR /app

# Core system tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    unzip \
    procps \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    golang \
    gcc \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# -------------------------
# Java (preinstalled dual version)
# -------------------------

RUN mkdir -p /opt/java

# Java 17 (Temurin)
RUN curl -L https://github.com/adoptium/temurin17-binaries/releases/latest/download/OpenJDK17U-jdk_x64_linux_hotspot.tar.gz \
    | tar -xz -C /opt/java && mv /opt/java/jdk-* /opt/java/java17

# Java 21 (Temurin)
RUN curl -L https://github.com/adoptium/temurin21-binaries/releases/latest/download/OpenJDK21U-jdk_x64_linux_hotspot.tar.gz \
    | tar -xz -C /opt/java && mv /opt/java/jdk-* /opt/java/java21

ENV JAVA17_HOME=/opt/java/java17
ENV JAVA21_HOME=/opt/java/java21

# -------------------------
# Rust
# -------------------------
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# -------------------------
# Node deps
# -------------------------
COPY package*.json ./
RUN npm install

# App
COPY . .

RUN mkdir -p /sandbox

ENV SANDBOX_ROOT=/sandbox
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
