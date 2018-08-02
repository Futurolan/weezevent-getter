FROM node:alpine

WORKDIR /usr/src/client
COPY . .
RUN npm install

CMD npm start
