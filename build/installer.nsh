; Custom NSIS — данные только в папке установки (не %APPDATA%)

!macro customInstall
!macroend

!macro customUnInstall
  RMDir /r "$INSTDIR\data"
  RMDir /r "$INSTDIR\files"
  Delete "$INSTDIR\logs.txt"
!macroend