#!/system/bin/sh
# KernelSU /data/adb/service.d/ 开机自启入口。
# 后台拉起守护后立即退出，不阻塞系统启动流程。
BASE=/data/adb/dsh-wb-bridge
nohup toybox setsid sh "$BASE/daemon.sh" >/dev/null 2>&1 &
exit 0
