@echo off
cd /d "%~dp0"
echo.
echo  Notizli audio diagnose - 30 seconds.
echo  Start this DURING a call, and let the other person talk the whole time.
echo.
notizli-audio-helper.exe --diagnose > "%~dp0notizli-audio-diagnose.txt" 2>&1
notepad "%~dp0notizli-audio-diagnose.txt"
