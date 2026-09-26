; Permiso en el firewall de Windows para que los celulares encuentren la compu
; y se conecten (sin esto Windows puede bloquearlos sin avisar, sobre todo si la
; red del lugar quedo marcada como "publica"). Si el instalador no tiene permisos
; de administrador, no pasa nada: Windows pregunta la primera vez que se abre.
; (la regla vieja, de cuando la app se llamaba "Multitrack Alabanza", se borra)
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Multitrack Alabanza"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirTracks Wireless Monitor"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="AirTracks Wireless Monitor" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="AirTracks Wireless Monitor"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Multitrack Alabanza"'
!macroend
