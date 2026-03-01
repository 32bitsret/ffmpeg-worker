FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  fonts-freefont-ttf \
  --no-install-recommends && \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
