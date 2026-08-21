# --- build stage: full install + compile ------------------------------------
# trixie = Debian 13 (glibc 2.40): satisfies the GLIBC_2.38 the sqlite3 prebuilt
# binary requires (bookworm/glibc 2.36 fails to dlopen it).
FROM node:24-trixie AS build
WORKDIR /usr/src/app

# package*.json first for layer caching (npm ci only re-runs when deps change)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- runtime stage: prod-only, no dev toolchain ------------------------------
FROM node:24-trixie
WORKDIR /usr/src/app
ENV NODE_ENV=production

# prod-only install (--omit=dev) shrinks the shipped tree to runtime deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist

EXPOSE 8005
CMD [ "node", "dist/index.js" ]