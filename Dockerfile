FROM node:lts-alpine

WORKDIR /app
ENV LOGLEVEL="info"
ENV PHOTO_DIR="/photos"

COPY package.json /app
RUN npm install --omit=dev

COPY src /app/src

EXPOSE 3000

CMD ["npm", "start"]
