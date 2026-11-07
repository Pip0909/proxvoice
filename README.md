# Proximity Voice

แชทเสียงตามระยะสำหรับ Minecraft Bedrock (แอพไมค์ภายนอก)

- `server/` เซิร์ฟเวอร์ (Python) + หน้าเว็บ/PWA — ดู `server/server.py` สำหรับตัวแปรสภาพแวดล้อม
- `app/` เปลือก Android (WebView) — GitHub Actions สร้าง APK ให้ที่หน้า Releases
- `render.yaml` ตั้งค่า deploy บน Render (New → Blueprint)

รหัสลับ `VC_API_KEY` ตั้งบนที่โฮสต์ ห้ามใส่ในโค้ด
