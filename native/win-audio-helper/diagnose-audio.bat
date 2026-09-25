@echo off
cd /d "%~dp0"
echo.
echo  Notizli audio diagnose - about 50 seconds. Leave this window open until Notepad appears.
echo  Start this DURING a call, and let the other person talk the whole time.
echo.
set HELPER=notizli-audio-helper.exe
if not exist "%HELPER%" if exist "target\release\notizli-audio-helper.exe" set HELPER=target\release\notizli-audio-helper.exe
"%HELPER%" --diagnose > "%~dp0notizli-audio-diagnose.txt" 2>&1
notepad "%~dp0notizli-audio-diagnose.txt"
