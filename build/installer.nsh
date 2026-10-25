!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\NCE.OpenWith" "" "Open with NCE"
  WriteRegStr HKCU "Software\Classes\*\shell\NCE.OpenWith" "Icon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\""
  WriteRegStr HKCU "Software\Classes\*\shell\NCE.OpenWith" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\*\shell\NCE.OpenWith\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""

  WriteRegStr HKCU "Software\Classes\Directory\shell\NCE.OpenWith" "" "Open with NCE"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NCE.OpenWith" "Icon" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\""
  WriteRegStr HKCU "Software\Classes\Directory\shell\NCE.OpenWith" "MultiSelectModel" "Player"
  WriteRegStr HKCU "Software\Classes\Directory\shell\NCE.OpenWith\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\NCE.OpenWith"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\NCE.OpenWith"
!macroend
