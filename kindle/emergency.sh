#!/bin/sh
# kindle-admin: al arrancar el Kindle,
#   1. SSH permanente por wifi en el puerto 22, solo con clave.
#   2. Abre KOReader cuando la interfaz del Kindle está lista.
#
# Va en /mnt/us/emergency.sh. Lo ejecuta en cada arranque /etc/upstart/kmc.conf
# (lo instala el jailbreak Véra). El SSH usa el dropbear de KOReader y la misma
# clave (koreader/settings/SSH/authorized_keys); el SSH de KOReader (2222) sigue igual.
#
# Para no abrir KOReader al arrancar: crear /mnt/us/NO_KOREADER_AUTOSTART
# (se puede hacer por cable). Para desactivar todo: borrar este archivo y reiniciar.

PORT=22
PIDFILE=/tmp/dropbear_kindle_admin.pid

# En segundo plano y desprendido del arranque, para no demorarlo nunca.
setsid sh -c "
  sleep 5
  cd /mnt/us/koreader || exit 0
  iptables -C INPUT -p tcp --dport $PORT -j ACCEPT 2>/dev/null ||
    iptables -A INPUT -p tcp --dport $PORT -j ACCEPT
  if [ -f $PIDFILE ] && kill -0 \$(cat $PIDFILE) 2>/dev/null; then exit 0; fi
  ./dropbear -E -R -s -p $PORT -P $PIDFILE
" > /dev/null 2>&1 < /dev/null &

setsid sh -c "
  [ -f /mnt/us/NO_KOREADER_AUTOSTART ] && exit 0
  # Esperar (hasta 3 min) a que esté la pantalla de inicio de Amazon: si KOReader
  # abre antes, la pantalla de inicio toma el control cuando termina de cargar.
  for i in \$(seq 1 90); do
    [ \"\$(lipc-get-prop com.lab126.appmgrd activeApp 2>/dev/null)\" = com.lab126.KPPMainApp ] && break
    sleep 2
  done
  sleep 3
  # KOReader corre como luajit (pgrep -f reader.lua daría positivo con este mismo script).
  pidof luajit > /dev/null && exit 0
  /var/local/kmc/bin/kpm launch koreader --asap
" > /dev/null 2>&1 < /dev/null &

exit 0
