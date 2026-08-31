FROM node:lts-alpine

# One real font: the admin overlay's box labels render text via librsvg,
# and a bare Alpine has neither fontconfig config nor any font to load.
RUN apk add --no-cache fontconfig ttf-dejavu

WORKDIR /app
ENV LOGLEVEL="info"
ENV PHOTO_DIR="/photos"

COPY package.json /app
RUN npm install --omit=dev

COPY src /app/src

EXPOSE 3000

CMD ["npm", "start"]
