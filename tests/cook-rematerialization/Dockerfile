FROM node:24.22.1-bookworm

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential \
       ca-certificates \
       cmake \
       curl \
       git \
       libssl-dev \
       ninja-build \
       pkg-config \
       python3 \
       tar \
       xz-utils \
       zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
