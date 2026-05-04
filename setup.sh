#!/bin/bash
# =========================================================
#  GPS 轨迹追踪系统 - VPS 一键安装脚本
#  适用: Ubuntu 20.04 / 22.04
#  安装: Mosquitto + PostgreSQL + TimescaleDB + Node.js + PM2 + Nginx
# =========================================================

set -e  # 任何步骤出错立即停止

echo "================================================="
echo "  GPS Tracker - VPS 安装脚本"
echo "================================================="

# ── 0. 检查是否以root运行 ─────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "❌ 请用 root 或 sudo 运行此脚本"
    exit 1
fi

# ── 1. 系统更新 ───────────────────────────────────────────
echo ""
echo "▶ [1/7] 更新系统包..."
#apt-get update -qq
#apt-get upgrade -y -qq

# ── 2. 安装 Mosquitto MQTT Broker ─────────────────────────
echo ""
echo "▶ [2/7] 安装 Mosquitto MQTT Broker..."

# 尝试通过 PPA 安装新版（2.x），失败则降级用系统源（1.6.x）
# 两种情况下后续的 passwd 写法都已兼容
apt-get install -y software-properties-common
if add-apt-repository -y ppa:mosquitto-dev/mosquitto-ppa 2>/dev/null; then
    apt-get update -qq
    echo "  使用 PPA 源（最新版）"
else
    echo "  PPA 不可用，使用系统源"
fi
apt-get install -y mosquitto mosquitto-clients
echo "  Mosquitto 版本: $(mosquitto -v 2>&1 | head -1)"

# 生成随机MQTT密码
MQTT_USER="gps_device"
MQTT_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
MQTT_ADMIN_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)

# 创建Mosquitto密码文件
# 注意：旧版1.6.x不支持 -c -b 同时使用，必须分开：先建文件再添加用户
touch /etc/mosquitto/passwd
chmod 600 /etc/mosquitto/passwd
mosquitto_passwd -b /etc/mosquitto/passwd $MQTT_USER $MQTT_PASS
mosquitto_passwd -b /etc/mosquitto/passwd admin $MQTT_ADMIN_PASS

# 写入Mosquitto配置
mkdir -p /var/log/mosquitto
chown mosquitto:mosquitto /var/log/mosquitto
cat >  /etc/mosquitto/conf.d/gps.conf << 'EOF'
# GPS Tracker MQTT 配置

# 全局认证（对所有listener生效，只写一次）
allow_anonymous false
password_file /etc/mosquitto/passwd

# TCP 端口
listener 1883

# WebSocket 端口
listener 9001
protocol websockets

# 日志
log_dest file /var/log/mosquitto/mosquitto.log
log_type error
log_type warning
log_type notice
EOF
systemctl enable mosquitto
systemctl restart mosquitto
sleep 1

# 验证启动状态
if systemctl is-active --quiet mosquitto; then
    echo "✅ Mosquitto 安装完成"
else
    echo "❌ Mosquitto 启动失败，日志如下："
    journalctl -u mosquitto -n 15 --no-pager
    exit 1
fi

# ── 3. 安装 PostgreSQL ────────────────────────────────────
echo ""
echo "▶ [3/7] 安装 PostgreSQL..."
apt-get install -y postgresql postgresql-contrib

# 生成数据库密码
DB_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
DB_NAME="gps_tracker"
DB_USER="gps_user"

# 创建数据库和用户
sudo -u postgres psql << EOSQL
CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOSQL

echo "✅ PostgreSQL 安装完成"

# ── 4. 安装 TimescaleDB ───────────────────────────────────
echo ""
echo "▶ [4/7] 安装 TimescaleDB（时序数据库插件）..."

# 添加TimescaleDB仓库
apt-get install -y gnupg
curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor -o /usr/share/keyrings/timescaledb.gpg
echo "deb [signed-by=/usr/share/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -cs) main" > /etc/apt/sources.list.d/timescaledb.list
apt-get update -qq

# 获取PostgreSQL版本
PG_VERSION=$(sudo -u postgres psql -t -c "SHOW server_version_num;" | tr -d ' ' | cut -c1-2)
apt-get install -y timescaledb-2-postgresql-$PG_VERSION 2>/dev/null || \
apt-get install -y timescaledb-2-postgresql-14 2>/dev/null || \
echo "⚠️  TimescaleDB安装失败，将使用普通PostgreSQL（功能不受影响，查询稍慢）"

# 启用TimescaleDB扩展
sudo -u postgres psql -d $DB_NAME << EOSQL
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
EOSQL

# 初始化数据表
sudo -u postgres psql -d $DB_NAME -U $DB_USER << EOSQL
-- GPS轨迹点表
CREATE TABLE IF NOT EXISTS gps_points (
    id          BIGSERIAL,
    imei        VARCHAR(20)   NOT NULL,
    ts          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    lat         DOUBLE PRECISION NOT NULL,  -- GCJ02纬度
    lon         DOUBLE PRECISION NOT NULL,  -- GCJ02经度
    lat_wgs     DOUBLE PRECISION,           -- 原始WGS84（调试用）
    lon_wgs     DOUBLE PRECISION,
    speed       REAL,                       -- 速度 km/h
    course      REAL,                       -- 航向角 度
    alt         REAL,                       -- 海拔 米
    sats        SMALLINT,                   -- 卫星数
    hdop        REAL,                       -- 水平精度因子
    raw         JSONB                       -- 完整原始数据备份
);

-- 转为时序超表（TimescaleDB核心功能，按时间自动分区）
SELECT create_hypertable('gps_points', 'ts', if_not_exists => TRUE);

-- 索引：按设备+时间查询（最常用）
CREATE INDEX IF NOT EXISTS idx_gps_imei_ts ON gps_points (imei, ts DESC);

-- 设备信息表
CREATE TABLE IF NOT EXISTS devices (
    imei        VARCHAR(20)   PRIMARY KEY,
    name        VARCHAR(100)  DEFAULT '',
    created_at  TIMESTAMPTZ   DEFAULT NOW(),
    last_seen   TIMESTAMPTZ,
    last_lat    DOUBLE PRECISION,
    last_lon    DOUBLE PRECISION,
    last_speed  REAL
);

EOSQL
echo "✅ TimescaleDB + 数据表 初始化完成"

# ── 5. 安装 Node.js 20 LTS ───────────────────────────────
echo ""
echo "▶ [5/7] 安装 Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pm2
echo "✅ Node.js $(node -v) + PM2 安装完成"

# ── 6. 安装 Nginx ─────────────────────────────────────────
echo ""
echo "▶ [6/7] 安装 Nginx..."
apt-get install -y nginx
systemctl enable nginx
systemctl start nginx
echo "✅ Nginx 安装完成"

# ── 7. 创建项目目录结构 ───────────────────────────────────
echo ""
echo "▶ [7/7] 创建项目目录..."
mkdir -p /opt/gps-tracker/{backend,frontend,logs}

# 写入环境变量配置文件
cat > /opt/gps-tracker/backend/.env << EOF
# ======= GPS Tracker 后端配置 =======
# MQTT
MQTT_HOST=localhost
MQTT_PORT=1883
MQTT_USER=$MQTT_USER
MQTT_PASS=$MQTT_PASS
MQTT_TOPIC_UP="/gps/up/#"
MQTT_TOPIC_DOWN=/gps/down/

# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS

# HTTP API
API_PORT=3000
API_SECRET=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)
EOF

chmod 600 /opt/gps-tracker/backend/.env

# ── 汇总输出安装结果 ─────────────────────────────────────
echo ""
echo "================================================="
echo "  ✅ 安装完成！请保存以下信息："
echo "================================================="
echo ""
echo "📡 MQTT Broker"
echo "   地址: $(curl -s ifconfig.me 2>/dev/null || echo 'your-vps-ip'):1883"
echo "   设备账号: $MQTT_USER"
echo "   设备密码: $MQTT_PASS"
echo "   管理账号: admin"
echo "   管理密码: $MQTT_ADMIN_PASS"
echo ""
echo "🗄️  PostgreSQL"
echo "   数据库: $DB_NAME"
echo "   用户名: $DB_USER"
echo "   密码:   $DB_PASS"
echo ""
echo "📁 项目目录: /opt/gps-tracker/"
echo ""
echo "⚠️  以上密码已保存到: /opt/gps-tracker/backend/.env"
echo "================================================="
echo ""
echo "下一步: 部署后端 Node.js 服务"
echo "  cd /opt/gps-tracker/backend"
echo "  npm install"
echo "  pm2 start server.js --name gps-tracker"
echo "================================================="
