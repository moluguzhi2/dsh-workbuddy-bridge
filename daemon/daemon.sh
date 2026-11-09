#!/system/bin/sh
# 常驻守护（由 KSU service.d 开机拉起，PPID 1，脱离 adb 与电脑）：
#   1. 19427 掉了就重新拉起 dsh-go app / 引擎，插件桥随之恢复（DNS 走引擎 proot，天然可用）；
#   2. 运行时升级或插件市场覆盖 node_modules/lib/index.js 时，用黄金副本还原；
#   3. 用 golden 还原 cordis.patch.yml：app 内的 agent 或设置页把 provider 改回
#      apiKeyEnv 时，会重现「API Key 无效或已过期」且请求根本发不出来；
#   4. 保证积分配置副本存在、属主正确，重启不丢。
# 不做独立进程、不改挂载：Android 上 /etc 是 /system/etc 软链，任何 tmpfs 挂载都可能
# 传播回宿主并覆盖系统配置；且非引擎进程发 DNS 会被 netd 拦。故持久性由守护 + 自愈实现。
BASE=/data/adb/dsh-wb-bridge
RF=/data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs
DST="$RF/root/.dsh/profiles/web/node_modules/dsh-workbuddy-bridge/lib/index.js"
DST_PATCH="$RF/root/.dsh/profiles/web/cordis.patch.yml"
PATCH_GOLDEN="$BASE/cordis.patch.yml.golden"
DCFG="$RF/root/.dsh/bridge-config.json"
PKG=io.github.ccch1mneyyy.dsh_app
LOG=/data/local/tmp/dsh-wb-bridge.log
INTERVAL=15
COOLDOWN_MAX=45

log() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

# 开机时 KSU 可能重复执行 service.d，只保留一个守护
n=$(ps -A -o ARGS 2>/dev/null | grep -c '[d]aemon\.sh')
[ "$n" -gt 1 ] && exit 0

port_up() {
  awk '$4=="0A" && index($2,":4BE3")>0 {ok=1} END{exit !ok}' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

app_alive() {
  ps -A -o ARGS 2>/dev/null | grep -q '[i]o.github.ccch1mneyyy.dsh_app'
}

ensure_config() {
  [ -f "$DCFG" ] || printf '%s\n' '{"credits":{"accessToken":"","userId":""}}' > "$DCFG"
  chown u0_a168:u0_a168 "$DCFG" 2>/dev/null
  chmod 664 "$DCFG" 2>/dev/null
}

# 升级顺序（关键）：先更新 golden（bridge.mjs），再更新 node_modules 里的 index.js。
# 只改 node_modules 不改 golden 的话，15 秒内会被本函数还原，表现为「改了又失效」。
sync_code() {
  [ -f "$DST" ] || return 0
  if ! cmp -s "$BASE/bridge.mjs" "$DST"; then
    cp "$BASE/bridge.mjs" "$DST"
    chown u0_a168:u0_a168 "$DST" 2>/dev/null
    chmod 644 "$DST" 2>/dev/null
    log "restored plugin index.js from golden copy"
  fi
}

# 渠道配置同样要有 golden：provider 一旦被改回 apiKeyEnv，app 会因凭据解析失败
# 直接判「API Key 无效或已过期」，连请求都不会发给桥。升级时先更新 golden。
sync_patch() {
  [ -f "$PATCH_GOLDEN" ] || return 0
  [ -f "$DST_PATCH" ] || return 0
  if ! cmp -s "$PATCH_GOLDEN" "$DST_PATCH"; then
    cp "$PATCH_GOLDEN" "$DST_PATCH"
    chown u0_a168:u0_a168 "$DST_PATCH" 2>/dev/null
    chmod 600 "$DST_PATCH" 2>/dev/null
    log "restored cordis.patch.yml from golden copy"
  fi
}

relaunch_app() {
  # 进程在但引擎没起：先强停，否则 am start 只会把已有 activity 带回前台。
  if app_alive; then
    log "app alive but bridge down, force-stop then relaunch"
    am force-stop "$PKG" >/dev/null 2>&1
    sleep 2
  else
    log "app not running, launching"
  fi
  monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
}

log "daemon start pid=$$ (guard mode)"
cooldown=0
while :; do
  [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ] && : > "$LOG"
  ensure_config
  sync_code
  sync_patch
  if port_up; then
    cooldown=0
  elif [ "$cooldown" -le 0 ]; then
    log "port 19427 down"
    relaunch_app
    cooldown=$COOLDOWN_MAX
  else
    log "waiting for engine startup, ${cooldown}s left"
  fi
  [ "$cooldown" -gt 0 ] && cooldown=$((cooldown - INTERVAL))
  sleep $INTERVAL
done
