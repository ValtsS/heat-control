# --- build stage: full install + compile ------------------------------------
FROM node:19 AS build
WORKDIR /usr/src/app

# package*.json first for layer caching (npm ci only re-runs when deps change)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime stage: prod-only, no dev toolchain ------------------------------
FROM node:19
WORKDIR /usr/src/app
ENV NODE_ENV=production

# prod-only install (--omit=dev) shrinks the shipped tree to runtime deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist

EXPOSE 8005
CMD [ "node", "dist/index.js" ]