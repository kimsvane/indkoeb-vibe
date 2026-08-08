# Brug en officiel Node.js LTS (Alpine for minimal størrelse)
FROM node:20-alpine

# Opret app-katalog
WORKDIR /app

# Kopier package.json og package-lock.json først (for bedre caching af docker lag)
COPY package*.json ./

# Installer kun produktions-afhængigheder
RUN npm ci --only=production

# Kopier kildekoden
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/

# Eksponer port 3000
EXPOSE 3000

# Angiv miljøvariabel til produktion
ENV NODE_ENV=production

# Start applikationen
CMD ["node", "server.js"]
