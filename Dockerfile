# Build
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# Runtime
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
# src + tsconfig: os seeds (tsx) importam módulos de src/
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# Documentos das entregas (guias, declarações): montar como volume persistente
ENV UPLOAD_DIR=/app/uploads
VOLUME /app/uploads
EXPOSE 3333
# Aplica migrations pendentes antes de subir a API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
