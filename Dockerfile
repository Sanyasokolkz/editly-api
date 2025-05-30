FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
  libx11-dev libxi-dev libgl1-mesa-dev libxext-dev \
  python3 make g++ pkg-config \
  && ln -s /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps --verbose

COPY . .

CMD ["npm", "start"]
