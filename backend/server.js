// =========================================================
//  server.js  —  GPS 轨迹追踪后端主服务
//  功能: MQTT订阅接收GPS数据 / REST API / WebSocket实时推送
//  运行: node server.js  或  pm2 start server.js
// =========================================================

require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const mqtt       = require("mqtt");
const { Pool }   = require("pg");
const path       = require("path");
const crypto     = require("crypto");

// ── 配置 ──────────────────────────────────────────────────
// ── 登录账号 (从.env读取，默认admin/admin，建议改) ──
const AUTH = {
    user:        process.env.WEB_USER     || "admin",
    pass:        process.env.WEB_PASS     || "admin",
    sessionTtl:  7 * 24 * 3600 * 1000,   // 7天
};
// 内存中的 session 存储 (重启会清空，重启后需重新登录)
const sessions = new Map();

function genToken() {
    return crypto.randomBytes(32).toString("hex");
}

function checkAuth(req) {
    const token = (req.headers.cookie || "")
        .split(";")
        .map(s => s.trim())
        .find(s => s.startsWith("session="));
    if (!token) return false;
    const t = token.replace("session=", "");
    const sess = sessions.get(t);
    if (!sess) return false;
    if (Date.now() > sess.expiresAt) {
        sessions.delete(t);
        return false;
    }
    return true;
}

const config = {
    mqtt: {
        url:      `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`,
        user:     process.env.MQTT_USER,
        pass:     process.env.MQTT_PASS,
        topicUp:  process.env.MQTT_TOPIC_UP  || "/gps/up/#",
        topicDown:process.env.MQTT_TOPIC_DOWN || "/gps/down/",
    },
    db: {
        host:     process.env.DB_HOST || "localhost",
        port:     parseInt(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME,
        user:     process.env.DB_USER,
        password: process.env.DB_PASS,
        max:      10,   // 连接池大小
    },
    api: {
        port:   parseInt(process.env.API_PORT) || 3000,
        secret: process.env.API_SECRET || "",
    }
};

// ── 数据库连接池 ──────────────────────────────────────────
const db = new Pool(config.db);
db.on("error", (err) => console.error("❌ DB连接错误:", err.message));

// ── Express + HTTP Server + Socket.IO ────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*" }   // 生产环境改为你的域名
});

app.use(express.json());

// ────────────────────────────────────────────────────────────
//  登录 / 登出 / 鉴权
// ────────────────────────────────────────────────────────────

// 登录页（即使未登录也能访问）
app.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "../frontend/login.html"));
});

// 登录接口
app.post("/api/login", (req, res) => {
    const { user, pass } = req.body || {};
    if (user === AUTH.user && pass === AUTH.pass) {
        const token = genToken();
        sessions.set(token, { user, expiresAt: Date.now() + AUTH.sessionTtl });
        res.cookie ? null : null; // express没装cookie-parser，自己设
        res.setHeader("Set-Cookie",
            `session=${token}; HttpOnly; Path=/; Max-Age=${AUTH.sessionTtl/1000}; SameSite=Lax`);
        console.log("✅ 登录成功:", user);
        res.json({ ok: true });
    } else {
        console.warn("❌ 登录失败:", user);
        res.status(401).json({ ok: false, error: "账号或密码错误" });
    }
});

// 登出接口
app.post("/api/logout", (req, res) => {
    const cookie = req.headers.cookie || "";
    const m = cookie.match(/session=([a-f0-9]+)/);
    if (m) sessions.delete(m[1]);
    res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
});

// 主页鉴权中间件 — 未登录访问 / 时跳转到 /login
app.get("/", (req, res, next) => {
    if (!checkAuth(req)) {
        return res.redirect("/login");
    }
    next();
});

// 静态文件：login.html 永远可访问；index.html 需要登录
app.use((req, res, next) => {
    // 登录页和登录API直接放行
    if (req.path === "/login" || req.path === "/login.html" ||
        req.path === "/api/login" || req.path === "/api/logout") {
        return next();
    }
    // 主页 index.html 需要登录
    if (req.path === "/" || req.path === "/index.html") {
        if (!checkAuth(req)) return res.redirect("/login");
    }
    next();
});

// 静态文件服务
app.use(express.static(path.join(__dirname, "../frontend")));

// =========================================================
//  MQTT 客户端 - 订阅设备上报数据
// =========================================================
const mqttClient = mqtt.connect(config.mqtt.url, {
    username:      config.mqtt.user,
    password:      config.mqtt.pass,
    clientId:      "gps_backend_" + Date.now(),
    reconnectPeriod: 5000,
    keepalive:     60,
});

mqttClient.on("connect", () => {
    console.log("✅ MQTT 已连接:", config.mqtt.url);
    mqttClient.subscribe(config.mqtt.topicUp, { qos: 1 }, (err) => {
        if (err) console.error("❌ 订阅失败:", err.message);
        else     console.log("📡 订阅主题:", config.mqtt.topicUp);
    });
    // 同时订阅设备状态主题（设备遗言会发到这里）
    mqttClient.subscribe("/gps/status/#", { qos: 1 }, (err) => {
        if (err) console.error("❌ 订阅status失败:", err.message);
        else     console.log("📡 订阅主题: /gps/status/#");
    });
});

mqttClient.on("error",      (err) => console.error("❌ MQTT错误:", err.message));
mqttClient.on("reconnect",  ()    => console.log("🔄 MQTT 重连中..."));
mqttClient.on("disconnect", ()    => console.warn("⚠️  MQTT 断开"));

// ── 处理设备上报的GPS数据 ─────────────────────────────────
mqttClient.on("message", async (topic, buffer) => {
    // 处理设备状态主题 (/gps/status/{imei})
    if (topic.startsWith("/gps/status/")) {
        const imei = topic.replace("/gps/status/", "");
        const status = buffer.toString();
        const isOnline = status === "online";
        console.log(`🔔 设备状态变更 [${imei}] -> ${status}`);
        // 更新状态表（供新连接的客户端获取当前状态）
        deviceStatusMap.set(imei, { online: isOnline, ts: Date.now() });
        io.emit("device_status", {
            imei:   imei,
            online: isOnline,
            ts:     Date.now()
        });
        return;
    }

    let data;
    try {
        data = JSON.parse(buffer.toString());
    } catch (e) {
        console.warn("⚠️  JSON解析失败, topic:", topic, "raw:", buffer.toString());
        return;
    }

    // 基本字段校验
    if (!data.imei || data.lat == null || data.lon == null) {
        console.warn("⚠️  数据字段不完整:", data);
        return;
    }

    console.log(`📍 [${data.imei}] lat:${data.lat} lon:${data.lon} speed:${data.speed}km/h sats:${data.sats}`);

    try {
        // 1. 写入gps_points表
        // 注意: 数据库表如果没有 sats_view 列，会自动忽略（存在 raw JSON 里）
        await db.query(`
            INSERT INTO gps_points
                (imei, ts, lat, lon, lat_wgs, lon_wgs, speed, course, alt, sats, hdop, raw)
            VALUES
                ($1, to_timestamp($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            data.imei,
            data.ts || Math.floor(Date.now() / 1000),
            data.lat,     data.lon,
            data.lat_wgs, data.lon_wgs,
            data.speed,   data.course,
            data.alt,     data.sats,
            data.hdop,
            JSON.stringify(data)  // sats_view 已在 raw 里
        ]);

        // 2. 更新设备最后位置（upsert）— 同时存 sats / hdop / csq 到 devices.last_meta
        await db.query(`
            INSERT INTO devices (imei, last_seen, last_lat, last_lon, last_speed, last_meta)
            VALUES ($1, NOW(), $2, $3, $4, $5)
            ON CONFLICT (imei) DO UPDATE SET
                last_seen  = NOW(),
                last_lat   = $2,
                last_lon   = $3,
                last_speed = $4,
                last_meta  = $5
        `, [
            data.imei, data.lat, data.lon, data.speed,
            JSON.stringify({
                sats: data.sats,
                sats_view: data.sats_view,
                hdop: data.hdop,
                csq: data.csq
            })
        ]);

        // 3. 通过 WebSocket 实时推送给所有在线的网页客户端
        io.emit("gps_update", {
            imei:   data.imei,
            lat:    data.lat,
            lon:    data.lon,
            speed:  data.speed,
            course: data.course,
            alt:    data.alt,
            sats:   data.sats,         // 用于定位的卫星数
            sats_view: data.sats_view, // 可见卫星总数
            hdop:   data.hdop,         // 水平精度因子
            csq:    data.csq,
            ts:     data.ts,
        });

        // 同时标记设备在线（每收到一条数据就刷新状态）
        deviceStatusMap.set(data.imei, { online: true, ts: Date.now() });
        io.emit("device_status", {
            imei:   data.imei,
            online: true,
            ts:     Date.now()
        });

    } catch (dbErr) {
        console.error("❌ 数据库写入失败:", dbErr.message);
    }
});

// =========================================================
//  REST API
// =========================================================

// GET /api/devices  —  获取所有设备列表（最后位置 + 在线状态）
app.get("/api/devices", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT imei, name, last_seen, last_lat, last_lon, last_speed,
                   last_meta->>'sats'      AS last_sats,
                   last_meta->>'sats_view' AS last_sats_view,
                   last_meta->>'hdop'      AS last_hdop,
                   last_meta->>'csq'       AS last_csq
            FROM devices
            ORDER BY last_seen DESC
        `);
        // 附加实时在线状态（来自 deviceStatusMap）
        const devices = result.rows.map(d => {
            const status = deviceStatusMap.get(d.imei);
            return {
                ...d,
                _online: status ? status.online : false,
                _statusTs: status ? status.ts : null,
            };
        });
        res.json({ ok: true, devices });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/track/:imei  —  查询指定设备的历史轨迹
// 参数: ?start=ISO时间&end=ISO时间&limit=1000
app.get("/api/track/:imei", async (req, res) => {
    const { imei } = req.params;
    const {
        start = new Date(Date.now() - 24 * 3600 * 1000).toISOString(), // 默认最近24小时
        end   = new Date().toISOString(),
        limit = 2000,
    } = req.query;

    try {
        const result = await db.query(`
            SELECT
                ts,
                lat, lon,
                speed, course, alt, sats, hdop
            FROM gps_points
            WHERE imei = $1
              AND ts BETWEEN $2 AND $3
            ORDER BY ts ASC
            LIMIT $4
        `, [imei, start, end, parseInt(limit)]);

        res.json({
            ok:     true,
            imei,
            count:  result.rows.length,
            points: result.rows,
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/latest/:imei  —  获取设备最新一条定位
app.get("/api/latest/:imei", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT ts, lat, lon, speed, course, alt, sats, hdop
            FROM gps_points
            WHERE imei = $1
            ORDER BY ts DESC
            LIMIT 1
        `, [req.params.imei]);

        if (result.rows.length === 0) {
            return res.status(404).json({ ok: false, error: "设备无数据" });
        }
        res.json({ ok: true, ...result.rows[0] });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/track/:imei  —  清空指定设备的所有轨迹数据
app.delete("/api/track/:imei", async (req, res) => {
    try {
        const r1 = await db.query(`DELETE FROM gps_points WHERE imei = $1`, [req.params.imei]);
        await db.query(`UPDATE devices SET last_lat=NULL, last_lon=NULL, last_speed=NULL, last_meta=NULL WHERE imei = $1`, [req.params.imei]);
        console.log(`🗑️  清空设备 ${req.params.imei} 的轨迹，共 ${r1.rowCount} 条`);
        res.json({ ok: true, deleted: r1.rowCount });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/track/:imei/keep  —  仅保留最近指定时间的数据，删除更早的
//   ?hours=N   保留最近 N 小时
//   ?days=N    保留最近 N 天
app.delete("/api/track/:imei/keep", async (req, res) => {
    const hours = parseInt(req.query.hours);
    const days = parseInt(req.query.days);
    let interval, label;
    if (hours > 0) {
        interval = `${hours} hours`;
        label = `${hours}小时`;
    } else if (days > 0) {
        interval = `${days} days`;
        label = `${days}天`;
    } else {
        return res.status(400).json({ ok: false, error: "需要 hours 或 days 参数" });
    }
    try {
        const r = await db.query(
            `DELETE FROM gps_points WHERE imei = $1 AND ts < NOW() - INTERVAL '${interval}'`,
            [req.params.imei]
        );
        console.log(`🗑️  设备 ${req.params.imei} 仅保留最近${label}，删除 ${r.rowCount} 条`);
        res.json({ ok: true, deleted: r.rowCount });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// DELETE /api/all  —  清空所有设备所有数据（慎用！）
app.delete("/api/all", async (req, res) => {
    try {
        const r1 = await db.query(`DELETE FROM gps_points`);
        await db.query(`UPDATE devices SET last_lat=NULL, last_lon=NULL, last_speed=NULL, last_meta=NULL`);
        console.log(`🗑️  清空全部数据，共 ${r1.rowCount} 条`);
        res.json({ ok: true, deleted: r1.rowCount });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// POST /api/device/:imei/name  —  修改设备备注名称
app.post("/api/device/:imei/name", async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name不能为空" });
    try {
        await db.query(`
            INSERT INTO devices (imei, name) VALUES ($1, $2)
            ON CONFLICT (imei) DO UPDATE SET name = $2
        `, [req.params.imei, name]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/stats/:imei  —  今日行驶统计
app.get("/api/stats/:imei", async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                COUNT(*)::int           AS point_count,
                ROUND(MAX(speed)::numeric, 1)   AS max_speed,
                ROUND(AVG(speed)::numeric, 1)   AS avg_speed,
                MIN(ts)                 AS first_ts,
                MAX(ts)                 AS last_ts
            FROM gps_points
            WHERE imei = $1
              AND ts >= NOW() - INTERVAL '24 hours'
        `, [req.params.imei]);
        res.json({ ok: true, stats: result.rows[0] });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── WebSocket 连接日志 ────────────────────────────────────
// 维护内存中的设备在线状态表 (imei -> {online, lastSeen})
const deviceStatusMap = new Map();

io.on("connection", (socket) => {
    console.log("🌐 网页客户端连接:", socket.id);

    // 新客户端连接时，主动推送所有设备的当前状态
    // 解决"打开网页比设备上线晚，错过 online 消息"的问题
    deviceStatusMap.forEach((status, imei) => {
        socket.emit("device_status", {
            imei: imei,
            online: status.online,
            ts: status.ts
        });
    });

    socket.on("disconnect", () => {
        console.log("🌐 网页客户端断开:", socket.id);
    });
});

// ── 启动服务 ──────────────────────────────────────────────
server.listen(config.api.port, () => {
    console.log("================================================");
    console.log(`  🚀 GPS Tracker 后端已启动`);
    console.log(`  📡 API & 网页: http://localhost:${config.api.port}`);
    console.log(`  🗄️  数据库: ${config.db.database}@${config.db.host}`);
    console.log("================================================");
});

// ── 优雅退出 ──────────────────────────────────────────────
process.on("SIGTERM", async () => {
    console.log("正在关闭服务...");
    mqttClient.end();
    await db.end();
    process.exit(0);
});
