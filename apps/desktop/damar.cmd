@echo off
rem DAMAR CLI launcher.
rem   damar                  new session
rem   damar resume [id]      session picker, or resume one session
rem   damar sessions         list saved sessions
rem   -Session "<Core dir>"  private Core data directory (remembered in the profile)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0RUN_DAMAR_CLI.ps1" %*
exit /b %ERRORLEVEL%
