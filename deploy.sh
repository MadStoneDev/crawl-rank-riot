#!/bin/bash
cd /var/www/rankriot-crawler
git pull origin main
npm ci
npm run build
pm2 restart rankriot-crawler || pm2 start dist/server.js --name rankriot-crawler
