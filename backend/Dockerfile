# Stage 1: compile casper-client from source
FROM rust:slim AS casper-builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev cmake && \
    cargo install casper-client

# Stage 2: Node.js runtime
FROM node:20-slim
COPY --from=casper-builder /usr/local/cargo/bin/casper-client /usr/local/bin/casper-client

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3001
CMD ["node", "src/server.js"]
