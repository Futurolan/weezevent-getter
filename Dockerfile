FROM node:15.14-alpine

WORKDIR /usr/src/client
COPY . .
RUN npm install

CMD npm start
