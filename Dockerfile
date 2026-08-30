FROM node:lts-alpine

WORKDIR /app
ENV LOGLEVEL="info"
ENV PHOTO_DIR="/photos"

COPY package.json /app

COPY app.js /app
COPY Logger.js /app
COPY Library.js /app
COPY ImmichApi.js /app

EXPOSE 3000

CMD ["npm", "start"]
