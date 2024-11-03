@echo off

xcopy "./src/assets" "dist/assets" /e /i /c /h /y
xcopy "./src/css" "dist/css" /e /i /c /h /y
xcopy "./src/html" "dist/html" /e /i /c /h /y
xcopy "./src/js" "dist/js" /e /i /c /h /y