#!/usr/bin/env bash
# 电脑端一键部署：把常驻桥装进手机，配置开机自启、插件代码自愈、配置副本。
# 前置：adb 已连接；设备已 root(KSU)；本脚本在仓库根目录的 deploy/ 下。
set -e
export MSYS_NO_PATHCONV=1
SRC="$(cd "$(dirname "$0")/.." && pwd -W 2>/dev/null || pwd)"
STAGE=/data/local/tmp/_wbdeploy
BASE=/data/adb/dsh-wb-bridge
RF=/data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs
DST="$RF/root/.dsh/profiles/web/node_modules/dsh-workbuddy-bridge/lib/index.js"
DCFG="$RF/root/.dsh/bridge-config.json"

echo "[1/7] 设备与 root 检查"
adb devices | awk 'NR>1 && /device$/ {found=1} END{exit !found}' || { echo "no adb device"; exit 1; }
adb shell id | grep -q 'uid=0' || { echo "device needs root (KernelSU)"; exit 1; }

echo "[2/7] 上传文件到临时目录"
adb shell "rm -rf $STAGE; mkdir -p $STAGE"
adb push "$SRC/lib/index.js" "$STAGE/bridge.mjs" >/dev/null
for f in daemon.sh service.sh config.example.json; do
  adb push "$SRC/deploy/$f" "$STAGE/$f" >/dev/null
done

echo "[3/7] 安装黄金副本到 $BASE"
adb shell "
  mkdir -p $BASE
  rm -f $BASE/inside.sh $BASE/run.sh $BASE/entry.mjs
  cp $STAGE/* $BASE/
  for f in $BASE/*.sh; do tr -d '\r' < \"\$f\" > \"\$f.tmp\" && mv \"\$f.tmp\" \"\$f\"; done
  chmod 755 $BASE/*.sh
  chmod 644 $BASE/*.mjs $BASE/*.json
  rm -rf $STAGE
"

echo "[4/7] 同步插件版 lib/index.js"
adb shell "cp $BASE/bridge.mjs $DST && chown u0_a168:u0_a168 $DST && chmod 644 $DST"

echo "[5/7] 建立配置副本（与 plugin / standalone 共用）"
adb shell "mkdir -p $RF/root/.dsh; [ -f $DCFG ] || cp $BASE/config.example.json $DCFG; chown u0_a168:u0_a168 $DCFG; chmod 664 $DCFG"

echo "[6/7] 开机自启 + 电池优化白名单"
adb shell "
  mkdir -p /data/adb/service.d
  cp $BASE/service.sh /data/adb/service.d/dsh-wb-bridge.sh
  chmod 755 /data/adb/service.d/dsh-wb-bridge.sh
  dumpsys deviceidle whitelist +io.github.ccch1mneyyy.dsh_app >/dev/null 2>&1 || true
"

echo "[7/7] 清理旧独立进程残留、重启引擎、启动守护并验证"
adb shell "
  # 字符类写法避免 pkill -f 匹配到 adb shell 自己的命令行
  pkill -f '[d]sh-wb-bridge/daemon.sh' 2>/dev/null || true
  pkill -f '[l]d-linux-aarch64.so.1' 2>/dev/null || true
  for i in 1 2 3 4 5 6; do grep -q ' /system/etc ' /proc/mounts || break; umount -l /system/etc 2>/dev/null || umount /system/etc 2>/dev/null || break; done
  rm -f $BASE/bridge.pid
  am force-stop io.github.ccch1mneyyy.dsh_app >/dev/null 2>&1
" >/dev/null 2>&1
sleep 2
adb shell "monkey -p io.github.ccch1mneyyy.dsh_app -c android.intent.category.LAUNCHER 1" >/dev/null 2>&1
sleep 18
adb shell "sh /data/adb/service.d/dsh-wb-bridge.sh"
sleep 3
adb forward --remove-all >/dev/null 2>&1 || true
adb forward tcp:19427 tcp:19427 >/dev/null 2>&1 || true
echo "--- healthz ---"
curl --noproxy '*' -s --max-time 12 http://127.0.0.1:19427/healthz || true
echo
echo "--- /credits ---"
curl --noproxy '*' -s --max-time 12 -o /dev/null -w "http=%{http_code}\n" http://127.0.0.1:19427/credits || true
echo "--- 宿主 /system/etc 挂载（应 CLEAN）---"
adb shell "grep ' /system/etc ' /proc/mounts || echo CLEAN" 2>&1 || true
echo "--- log ---"
adb shell "tail -8 /data/local/tmp/dsh-wb-bridge.log" 2>&1 || true
