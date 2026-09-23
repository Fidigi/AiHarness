FROM ubuntu:24.04

# Variables configurables via docker build --build-arg
ARG GIT_USER_NAME
ARG GIT_USER_EMAIL
ARG WSL_UID
ARG WSL_GID
ARG DOCKER_GID

# Dépendances système + Node.js 22 + Docker CLI
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl ca-certificates gnupg git sudo jq \
       python3 python3-pip python3-venv \
       build-essential pkg-config \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && echo "ALL ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/all \
    && chmod 0440 /etc/sudoers.d/all \
    && rm -f /etc/pam.d/sudo \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Git config
RUN git config --global user.name "$GIT_USER_NAME" \
    && git config --global user.email "$GIT_USER_EMAIL"

# Utilisateur ubuntu + Docker group
RUN groupadd -g $WSL_GID ubuntu 2>/dev/null || true \
    && (id ubuntu >/dev/null 2>&1) || useradd -u $WSL_UID -g ubuntu -m ubuntu \
    && groupadd -g $DOCKER_GID docker 2>/dev/null || groupadd docker 2>/dev/null || true \
    && (id ubuntu >/dev/null 2>&1 && usermod -aG docker ubuntu) || true \
    && mkdir -p /home/ubuntu/.claude \
    && chown -R ubuntu:ubuntu /home/ubuntu

# Claude Code via npm
USER ubuntu
RUN npm config set prefix /home/ubuntu/.npm-global \
    && npm install -g @anthropic-ai/claude-code \
    && chown -R ubuntu:ubuntu /home/ubuntu/.npm-global

ENV PATH="/home/ubuntu/.local/bin:/home/ubuntu/.npm-global/bin:$PATH"

WORKDIR /app

LABEL description="Claude Code full dev environment"
