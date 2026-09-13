# ไม่มี dependency ภายนอก เลยไม่ต้อง npm install และไม่ต้อง build stage
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    ASHER_DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server/ ./server/
COPY shared/ ./shared/
COPY modules/ ./modules/
COPY data/sample-competitors.json ./data/

# ข้อมูลอยู่นอก image — ต้อง mount volume ทับ ไม่งั้นหายทุกครั้งที่ deploy ใหม่
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 8000

# ใช้ /api/health ตัวเดียวกับที่ platform อื่นเรียกได้ ไม่ต้องมี endpoint แยก
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ไม่มี shell wrapper คั่น เพื่อให้ SIGTERM ถึง node ตรง ๆ (graceful shutdown ถึงจะทำงาน)
CMD ["node", "server/server.js"]
