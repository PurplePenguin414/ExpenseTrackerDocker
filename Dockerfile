FROM node:20-slim

WORKDIR /app

# Needed to build better-sqlite3 native bindings
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
