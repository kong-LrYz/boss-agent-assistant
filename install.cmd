@echo off
call "%~dp0start.cmd" --open-chrome-download %*
exit /b %errorlevel%
