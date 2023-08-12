FROM node:19
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

EXPOSE 8005


CMD [ "node", "dist/index.js" ]

