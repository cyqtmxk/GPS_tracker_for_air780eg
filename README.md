<img width="635" height="560" alt="说明" src="https://github.com/user-attachments/assets/f4fc299b-72c4-47e8-8c78-f3ffdedb4823" />

系统简介：
硬件层 — Air780 模块通过 Lua 固件采集 GPS 坐标，通过 4G 网络上报数据。
传输层 — 推荐用 MQTT 协议（省电、可靠，断网重连友好），EMQX 或 Mosquitto 部署在你的 VPS 上。
服务器层 — 后端接收 MQTT 消息，解析 NMEA 格式 GPS 数据，存入 PostgreSQL（或 TimescaleDB，对时序数据更优化）。
展示层 — 网页用 Leaflet.js 渲染轨迹地图，同时支持手机访问（PWA）。

第一步：VPS 上一键安装环境 上传 setup.sh 到 VPS，然后执行：
chmod +x setup.sh \
sudo bash setup.sh
脚本会自动安装所有组件，并在最后打印 MQTT 和数据库的账号密码，务必保存好。

第二步：部署后端服务
将 server.js 和 package.json 上传到 /opt/gps-tracker/backend/
cd /opt/gps-tracker/backend \
npm install \
pm2 start server.js --name gps-tracker \
pm2 save          # 开机自启 \
pm2 startup       # 生成开机启动命令（按提示执行）

第三步：配置 Nginx
cp gps-tracker.nginx /etc/nginx/sites-available/gps-tracker \
ln -s /etc/nginx/sites-available/gps-tracker /etc/nginx/sites-enabled/ 
nginx -t          # 检查配置 
systemctl reload nginx 

第四步：更新 Air780EG 固件里的 MQTT 配置
把 main.lua 里 CFG 的 mqtt_host、mqtt_user、mqtt_pass 改成 setup.sh 输出的值。

安装完成后，可以用以下命令验证：
测试MQTT（需要安装mosquitto-clients）

mosquitto_pub -h localhost -p 1883 -u gps_device -P 你的密码 -t "/gps/up/test123"  -m '{"imei":"test123","lat":35.68,"lon":139.69,"speed":30,"ts":1714000000}'

#查看日志
pm2 logs gps-tracker 

第五步：申请高德地图 Key

访问 lbs.amap.com 注册开发者账号
创建应用 → 添加 Key → 服务平台选 "Web端(JS API)"
把 index.html 第 9 行的 YOUR_AMAP_KEY 替换为你的 Key


第六步：部署到 VPS
cp index.html /opt/gps-tracker/frontend/index.html \
cp login.html /opt/gps-tracker/frontend/login.html 

cat >> /opt/gps-tracker/backend/.env << 'EOF' \
WEB_USER=你的用户名 \
WEB_PASS=你的密码 \
EOF

#重启服务

fuser -k 3000/tcp \
sleep 2 \
pm2 delete gps-tracker \
cd /opt/gps-tracker/backend \
pm2 start server.js --name gps-tracker --update-env \
sleep 3 \
pm2 logs gps-tracker --lines 15 --nostream
