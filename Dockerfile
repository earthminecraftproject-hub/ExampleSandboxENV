FROM node:20-slim

WORKDIR /app

# -------------------------
# System dependencies
# -------------------------
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    unzip \
    jq \
    tar \
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
# Java (Adoptium API - stable)
# -------------------------
RUN mkdir -p /opt/java

# Java 17
RUN J17_URL=$(curl -s "https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=linux" \
    | jq -r '.[0].binary.package.link') && \
    curl -L "$J17_URL" -o /tmp/jdk17.tar.gz && \
    tar -xzf /tmp/jdk17.tar.gz -C /opt/java && \
    mv /opt/java/jdk-* /opt/java/java17 && \
    rm /tmp/jdk17.tar.gz

# Java 21
RUN J21_URL=$(curl -s "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux" \
    | jq -r '.[0].binary.package.link') && \
    curl -L "$J21_URL" -o /tmp/jdk21.tar.gz && \
    tar -xzf /tmp/jdk21.tar.gz -C /opt/java && \
    mv /opt/java/jdk-* /opt/java/java21 && \
    rm /tmp/jdk21.tar.gz

# Java env paths
ENV JAVA17_HOME=/opt/java/java17
ENV JAVA21_HOME=/opt/java/java21

# -------------------------
# Rust
# -------------------------
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# -------------------------
# App dependencies
# -------------------------
COPY package*.json ./
RUN npm install

# -------------------------
# App source
# -------------------------
COPY . .

# -------------------------
# Sandbox workspace
# -------------------------
RUN mkdir -p /sandbox

ENV SANDBOX_ROOT=/sandbox
ENV PORT=8080

# -------------------------
# Sanity checks (important)
# -------------------------
RUN /opt/java/java17/bin/java -version && \
    /opt/java/java21/bin/java -version && \
    python3 --version && \
    node --version && \
    go version && \
    cargo --version

EXPOSE 8080

CMD ["node", "server.js"]
